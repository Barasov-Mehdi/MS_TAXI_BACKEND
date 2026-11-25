/**
 * Ləğv və gözləmə haqları (Bolt modeli, nağd ödəniş üçün).
 *
 * Ləğv haqqı:
 *  - Müştəri sifarişi sürücü GƏLİB ÇATDIQDAN sonra, və ya sürücü qəbul etdikdən `freeCancelSeconds` (default 120 san)
 *    sonra ləğv edirsə, tarifdəki `cancellationFeeMinor` tutulur (0 → haqq yoxdur, admin paneldən təyin olunur).
 *  - Onlayn ödəniş olmadığı üçün haqq müştərinin "borcu" kimi yazılır (Customer.pendingFees) və NÖVBƏTİ səfərin
 *    qiymətinə əlavə olunur. Həmin səfər bitəndə: pulu nağd alan sürücünün balansından çıxılır, ləğv olunan
 *    sifarişin sürücüsünün balansına yazılır (platforma üçün sıfır, ilkin sürücü kompensasiya alır).
 *
 * Gözləmə haqqı:
 *  - Sürücü çatdıqdan `freeWaitingMinutes` (default 3 dəq) sonra hər dəqiqə üçün tarifdəki `waitingFeePerMinuteMinor`.
 *    Səfər başlayanda bir dəfə hesablanır və qiymətə əlavə olunur.
 */
const { Customer } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');

// Bu vəziyyətlərdə sürücü artıq müştəriyə doğru gəlir (növbədəki sifarişlər üçün haqq yoxdur)
const FEE_STATUSES = new Set([
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.DRIVER_ON_THE_WAY,
  OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
  OrderStatus.DRIVER_ARRIVED,
]);

async function ruleFor(order) {
  try {
    const pricing = require('./pricing.service');
    return await pricing.getActiveRule(pricing.normalizeVehicleType(order.vehicleType || 'basic'));
  } catch (_) {
    return null;
  }
}

/**
 * Müştəri İNDİ ləğv etsə tutulacaq haqq. { amountMinor, reason, freeUntil }
 * freeUntil: pulsuz ləğvin bitmə vaxtı (tətbiqdə geri sayım üçün), haqq yoxdursa null.
 */
async function cancellationFeeFor(order, settings = {}, now = new Date()) {
  const none = { amountMinor: 0, reason: null, freeUntil: null };
  if (!order || !order.driverId || !FEE_STATUSES.has(order.status)) return none;
  const rule = await ruleFor(order);
  const fee = Math.max(0, Math.round(Number((rule && rule.cancellationFeeMinor) || settings.cancellationFeeMinor || 0)));
  if (!fee) return none;
  const freeMs = Math.max(0, Number(settings.freeCancelSeconds ?? 120)) * 1000;
  const acceptedAt = order.acceptedAt ? new Date(order.acceptedAt).getTime() : null;
  const freeUntil = acceptedAt ? new Date(acceptedAt + freeMs) : null;
  if (order.status === OrderStatus.DRIVER_ARRIVED) return { amountMinor: fee, reason: 'DRIVER_ARRIVED', freeUntil };
  if (acceptedAt && now.getTime() > acceptedAt + freeMs) return { amountMinor: fee, reason: 'LATE_CANCEL', freeUntil };
  return { amountMinor: 0, reason: null, freeUntil, feeMinor: fee };
}

/** Səfər başlayanda: pulsuz gözləmədən artıq dəqiqələr üçün haqq (qəpik). */
async function waitingFeeFor(order, settings = {}, now = new Date()) {
  if (!order || !order.arrivedAt) return { amountMinor: 0, minutes: 0 };
  const rule = await ruleFor(order);
  const perMin = Math.max(0, Math.round(Number((rule && rule.waitingFeePerMinuteMinor) || 0)));
  if (!perMin) return { amountMinor: 0, minutes: 0 };
  const freeMin = Math.max(0, Number(settings.freeWaitingMinutes ?? 3));
  const waited = (now.getTime() - new Date(order.arrivedAt).getTime()) / 60000;
  const paidMin = Math.floor(Math.max(0, waited - freeMin));
  return { amountMinor: paidMin * perMin, minutes: paidMin };
}

/** Müştərinin ödənilməmiş haqları (növbəti sifarişə əlavə olunacaq). */
async function pendingFeesOf(customerId) {
  try {
    const c = await Customer.findById(customerId).select('pendingFees').lean();
    return (c && Array.isArray(c.pendingFees) ? c.pendingFees : []).filter((f) => f && f.amountMinor > 0);
  } catch (_) {
    return [];
  }
}

const sumFees = (fees) => (fees || []).reduce((s, f) => s + (Number(f.amountMinor) || 0), 0);

async function addCustomerDebt(customerId, fee, session) {
  if (!fee || !fee.amountMinor) return;
  await Customer.updateOne(
    { _id: customerId, 'pendingFees.orderId': { $ne: fee.orderId } },
    { $push: { pendingFees: { orderId: fee.orderId, driverId: fee.driverId, amountMinor: fee.amountMinor, createdAt: new Date() } } },
    session ? { session } : {}
  );
}

/**
 * Səfər bitdi və müştəri köhnə haqları nağd ödədi: pulu alan sürücüdən çıxılır, ilkin sürücüyə yazılır,
 * müştərinin borcu silinir. Session daxilində, idempotent (idempotencyKey).
 */
async function settleCollectedFees(order, collectingDriverId, session) {
  const fees = (order.collectedFees || []).filter((f) => f && f.amountMinor > 0);
  if (!fees.length) return;
  const wallet = require('./wallet.service');
  for (const f of fees) {
    const sameDriver = f.driverId && String(f.driverId) === String(collectingDriverId);
    if (!sameDriver) {
      await wallet.applyTransaction({
        driverId: collectingDriverId,
        type: 'CANCELLATION_FEE',
        amountMinor: -f.amountMinor,
        referenceType: 'ORDER',
        referenceId: order._id,
        idempotencyKey: `feecollect:${order._id}:${f.orderId}`,
        note: 'Müştərinin əvvəlki ləğv haqqı nağd alındı (ilkin sürücüyə ötürülür)',
        session,
        allowNegative: true,
      });
      if (f.driverId) {
        await wallet.applyTransaction({
          driverId: f.driverId,
          type: 'CANCELLATION_FEE',
          amountMinor: f.amountMinor,
          referenceType: 'ORDER',
          referenceId: f.orderId,
          idempotencyKey: `feecredit:${f.orderId}`,
          note: 'Müştərinin ləğv haqqı (kompensasiya)',
          session,
        });
      }
    }
  }
  await Customer.updateOne(
    { _id: order.customerId },
    { $pull: { pendingFees: { orderId: { $in: fees.map((f) => f.orderId) } } } },
    session ? { session } : {}
  );
}

module.exports = {
  FEE_STATUSES,
  cancellationFeeFor,
  waitingFeeFor,
  pendingFeesOf,
  sumFees,
  addCustomerDebt,
  settleCollectedFees,
};
