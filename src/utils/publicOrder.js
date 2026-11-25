/**
 * Müştəriyə qaytarılan sifariş: yalnız tətbiqin ehtiyacı olan sahələr.
 * Əvvəl bazadakı sənəd olduğu kimi gedirdi: offeredToDriverIds / rejectedDriverIds (hansı sürücülərin
 * imtina etdiyi), currentOfferDriverId, idempotencyKey, dispatchSeq, commissionApplied və s. müştəriyə görünürdü.
 */
const PICK = [
  '_id', 'customerId', 'driverId', 'status',
  'pickup', 'destination', 'pickupAddress', 'pickupLabel', 'stops',
  'distanceMeters', 'durationMin', 'vehicleType', 'paymentMethod', 'passenger', 'promoCode',
  'acceptedAt', 'arrivedAt', 'startedAt', 'completedAt', 'cancelledAt', 'cancelReason', 'cancelledBy',
  'searchDeadlineAt', 'tripMeters', 'stoppedEarly', 'continuedToOrderId', 'continuedFromOrderId',
  'scheduledRideId', 'ratingId', 'version', 'createdAt', 'updatedAt',
];

const SNAPSHOT_PICK = [
  'baseFareMinor', 'distanceFareMinor', 'timeFareMinor', 'stopFareMinor', 'waitingFareMinor', 'discountMinor',
  'surgeMultiplier', 'finalPriceMinor', 'originalFinalPriceMinor', 'initialFinalPriceMinor', 'cancellationDebtMinor',
  'vehicleType',
];

function plain(doc) {
  if (!doc) return null;
  return typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

function publicOrder(doc, extra = {}) {
  const o = plain(doc);
  if (!o) return null;
  const out = {};
  for (const k of PICK) if (o[k] !== undefined) out[k] = o[k];
  out.id = o._id;
  const snap = o.pricingSnapshot || {};
  out.pricingSnapshot = {};
  for (const k of SNAPSHOT_PICK) if (snap[k] !== undefined && snap[k] !== null) out.pricingSnapshot[k] = snap[k];
  if (o.cancellationFee && o.cancellationFee.amountMinor) {
    out.cancellationFee = { amountMinor: o.cancellationFee.amountMinor, reason: o.cancellationFee.reason };
  }
  const changes = o.routeChanges || [];
  out.routeChangeCount = changes.length;
  if (changes.length) {
    const last = changes[changes.length - 1];
    out.lastRouteChange = { at: last.at, fromPriceMinor: last.fromPriceMinor, toPriceMinor: last.toPriceMinor };
  }
  return { ...out, ...extra };
}

module.exports = { publicOrder };
