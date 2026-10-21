const { Driver, WalletTransaction } = require('../models');
const { getSettings } = require('./settings.service');
const { AppError } = require('../utils/errors');
const { percentOf } = require('../utils/money');

/**
 * Bakiye dəyişikliyi ATOMİKDİR: tək `findOneAndUpdate` ($inc) ilə edilir, yəni eyni anda gələn
 * iki əməliyyat bir-birinin üzərinə yazmır. Mənfi bakiyə qadağandırsa, şərt eyni sorğunun içindədir.
 * idempotencyKey təkrar çağırışda eyni əməliyyatı qaytarır (və bakiyəni ikinci dəfə dəyişmir).
 */
async function applyTransaction({
  driverId, type, amountMinor, referenceType, referenceId,
  idempotencyKey, note, createdBy, session,
  // true: bakiye mənfiyə düşə bilər (məs. artıq bitmiş səfərin komissiyası). Səfər başa çatıb,
  // bakiye çatmır deyə onu bloklamaq olmaz - əks halda sürücü səfəri bitirə bilməz.
  allowNegative = false,
}) {
  const sess = session || null;
  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(sess);
  if (existing) return existing;

  const settings = await getSettings();
  const filter = { _id: driverId };
  if (amountMinor < 0 && !settings.negativeBalanceAllowed && !allowNegative) {
    filter.$expr = { $gte: [{ $ifNull: ['$walletBalanceMinor', 0] }, -amountMinor] };
  }

  // new:false → dəyişiklikdən ƏVVƏLKİ sənəd qayıdır (balanceBefore üçün)
  const prev = await Driver.findOneAndUpdate(
    filter,
    { $inc: { walletBalanceMinor: amountMinor } },
    { new: false, session: sess }
  );
  if (!prev) {
    const exists = await Driver.exists({ _id: driverId }).session(sess);
    if (!exists) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);
    throw new AppError('INSUFFICIENT_BALANCE', 'Driver wallet balance insufficient', 400);
  }
  const before = prev.walletBalanceMinor || 0;
  const after = before + amountMinor;

  try {
    const [tx] = await WalletTransaction.create(
      [{ driverId, type, amountMinor, balanceBeforeMinor: before, balanceAfterMinor: after,
         referenceType, referenceId, idempotencyKey, note, createdBy }],
      { session: sess }
    );
    return tx;
  } catch (e) {
    // Paralel təkrar sorğu eyni açarı artıq yazıb: bizim $inc-i geri qaytarırıq.
    await Driver.updateOne({ _id: driverId }, { $inc: { walletBalanceMinor: -amountMinor } }, { session: sess });
    if (e.code === 11000) return WalletTransaction.findOne({ idempotencyKey }).session(sess);
    throw e;
  }
}

/** Sürücünün reytinqinə görə tətbiq olunan komissiya tarifi (ayarlardan). */
function commissionPolicy(settings, ratingAvg) {
  const threshold = Number(settings.ratingThreshold ?? 3);
  const inclusive = settings.lowRatingInclusive !== false; // default: 3.0 da "aşağı" sayılır
  const r = Number(ratingAvg ?? 5);
  const isLowRated = inclusive ? r <= threshold : r < threshold;
  const rate = isLowRated ? Number(settings.lowRatingCommission ?? 15) : Number(settings.tripCommission ?? 10);
  return { isLowRated, rate, type: settings.tripCommissionType === 'FIXED' ? 'FIXED' : 'PERCENTAGE', threshold, inclusive };
}

/**
 * Səfər bitəndə çağırılır. Sürücünün HAZIRKI reytinqi (bu səfər qiymətləndirilməzdən əvvəl) əsas götürülür:
 *  reytinq ≤ 3 → qiymətin 15%-i, reytinq > 3 → 10%-i (dəyərlər admin ayarlarındadır).
 * Qaytarır: { tx, commissionMinor, rate, ratingAvg }
 */
async function applyTripCommission(driverId, order, session) {
  const settings = await getSettings();
  const driver = await Driver.findById(driverId).session(session || null);
  if (!driver) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);

  const ratingAvg = driver.ratingAvg ?? 5;
  const { isLowRated, rate } = commissionPolicy(settings, ratingAvg);

  const fare = order.pricingSnapshot.finalPriceMinor;
  const commissionMinor = settings.tripCommissionType === 'FIXED'
    ? Math.round(rate)
    : percentOf(fare, rate);

  if (commissionMinor <= 0) return { tx: null, commissionMinor: 0, rate, ratingAvg };

  const tx = await applyTransaction({
    driverId,
    type: 'TRIP_COMMISSION',
    amountMinor: -commissionMinor,
    referenceType: 'ORDER',
    referenceId: order._id,
    idempotencyKey: `commission:${order._id}`,
    note: isLowRated
      ? `Aşağı reytinq komissiyası: ${rate}% (reytinq: ${Number(ratingAvg).toFixed(2)})`
      : `Standart komissiya: ${rate}%`,
    session,
    // Səfər artıq bitib: komissiya bakiyədən çox olsa belə səfərin tamamlanmasına mane olmamalıdır.
    // Bakiye mənfi olarsa matching.driverCanTakeNewOrder sürücünü yeni sifarişlərdən kənar saxlayır (LOW_BALANCE).
    allowNegative: true,
  });
  return { tx, commissionMinor: Math.abs(tx.amountMinor), rate, ratingAvg };
}

module.exports = { applyTransaction, applyTripCommission, commissionPolicy };
