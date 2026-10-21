const { Order, TripEarning, WalletTransaction, SystemSetting } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');

const DONE = [OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING, OrderStatus.COMPLETED];

/** Komissiya qeydindəki faizi oxuyur: "Standart komissiya: 10%", "Standart komisyon: %13". */
function rateFromNote(note) {
  const m = String(note || '').match(/%\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*%/);
  const v = m ? Number(String(m[1] || m[2]).replace(',', '.')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Köhnə məlumat üçün qazanc jurnalını (TripEarning) doldurur. İdempotentdir (orderId unikal).
 *  1) Bazada qalan tamamlanmış sifarişlər → dəqiq qeyd.
 *  2) Sifarişi artıq SİLİNMİŞ, amma komissiya əməliyyatı qalan səfərlər → komissiya faizindən
 *     gross təxmini bərpa olunur (reconstructed: true).
 */
async function backfillEarnings({ log = console.log } = {}) {
  let fromOrders = 0;
  let reconstructed = 0;

  const orders = await Order.find({ driverId: { $ne: null }, status: { $in: DONE } })
    .select('_id driverId completedAt updatedAt pricingSnapshot distanceMeters durationMin paymentMethod pickupAddress pickupLabel stops')
    .lean();
  const commissionByOrder = new Map(
    (
      await WalletTransaction.find({ type: 'TRIP_COMMISSION', referenceId: { $in: orders.map(o => o._id) } })
        .select('referenceId amountMinor note')
        .lean()
    ).map(t => [String(t.referenceId), t])
  );

  for (const o of orders) {
    const gross = (o.pricingSnapshot && o.pricingSnapshot.finalPriceMinor) || 0;
    const tx = commissionByOrder.get(String(o._id));
    const commissionMinor = tx ? Math.abs(tx.amountMinor) : 0;
    const last = (o.stops || [])[(o.stops || []).length - 1] || {};
    const r = await TripEarning.updateOne(
      { orderId: o._id },
      {
        $setOnInsert: {
          driverId: o.driverId,
          orderId: o._id,
          completedAt: o.completedAt || o.updatedAt || new Date(),
          grossMinor: gross,
          commissionMinor,
          netMinor: gross - commissionMinor,
          commissionRate: tx ? rateFromNote(tx.note) : null,
          distanceMeters: o.distanceMeters || 0,
          durationMin: o.durationMin || 0,
          paymentMethod: o.paymentMethod || 'CASH',
          pickupAddress: o.pickupAddress || o.pickupLabel || '',
          destinationAddress: last.address || last.label || '',
        },
      },
      { upsert: true }
    );
    if (r.upsertedCount) fromOrders += 1;
  }

  // Sifarişi silinmiş, amma komissiyası qalan səfərlər
  const existing = new Set((await TripEarning.find().select('orderId').lean()).map(e => String(e.orderId)));
  const orphanTx = await WalletTransaction.find({ type: 'TRIP_COMMISSION', referenceType: 'ORDER' })
    .select('driverId referenceId amountMinor note createdAt')
    .lean();
  for (const t of orphanTx) {
    if (!t.referenceId || existing.has(String(t.referenceId))) continue;
    const commissionMinor = Math.abs(t.amountMinor);
    const rate = rateFromNote(t.note);
    const gross = rate ? Math.round((commissionMinor * 100) / rate) : 0;
    const r = await TripEarning.updateOne(
      { orderId: t.referenceId },
      {
        $setOnInsert: {
          driverId: t.driverId,
          orderId: t.referenceId,
          completedAt: t.createdAt,
          grossMinor: gross,
          commissionMinor,
          netMinor: gross - commissionMinor,
          commissionRate: rate,
          reconstructed: true,
        },
      },
      { upsert: true }
    );
    if (r.upsertedCount) reconstructed += 1;
  }

  log(`[earnings] backfill: ${fromOrders} sifarişdən, ${reconstructed} silinmiş sifariş komissiyadan bərpa olundu`);
  return { fromOrders, reconstructed };
}

/** Server başlayanda bir dəfə işləyir (bayraq ilə). */
async function backfillOnce() {
  const flag = await SystemSetting.findOne({ key: 'migration_earnings_v1' }).lean();
  if (flag) return null;
  const res = await backfillEarnings();
  await SystemSetting.updateOne(
    { key: 'migration_earnings_v1' },
    { $set: { key: 'migration_earnings_v1', value: { at: new Date().toISOString(), ...res } } },
    { upsert: true }
  );
  return res;
}

module.exports = { backfillEarnings, backfillOnce, rateFromNote };
