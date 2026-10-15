const { PricingRule } = require('../models');
const { haversineMeters } = require('../utils/geo');

const VEHICLE_TYPES = ['basic', 'city', 'bolt'];
const DEFAULT_SPEED_KMH = 30;

/**
 * Nəqliyyat sinfi üçün aktiv tarif. Həmin sinif üçün qayda yoxdursa 'basic',
 * o da yoxdursa istənilən aktiv qayda istifadə olunur.
 */
async function getActiveRule(vehicleType = 'basic') {
  const latest = (filter) => PricingRule.findOne({ active: true, ...filter }).sort({ updatedAt: -1 });
  let rule = await latest(vehicleType === 'basic'
    ? { $or: [{ vehicleType: 'basic' }, { vehicleType: { $exists: false } }] }
    : { vehicleType });
  if (!rule && vehicleType !== 'basic') {
    rule = await latest({ $or: [{ vehicleType: 'basic' }, { vehicleType: { $exists: false } }] });
  }
  if (!rule) rule = await latest({});
  return rule;
}

/**
 * Marşrutun məsafəsi və müddəti. Müştərinin göndərdiyi (Mapbox) dəyər yalnız məntiqli
 * hüdudlardadırsa qəbul edilir; əks halda düz xətt məsafəsindən təxmin edilir.
 */
function resolveTripMetrics({ points, distanceMeters, durationMin }) {
  let straight = 0;
  for (let i = 1; i < points.length; i += 1) {
    straight += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  const d = Number(distanceMeters);
  const okDistance = Number.isFinite(d) && d >= straight * 0.95 && d <= straight * 3 + 500;
  const finalDistance = okDistance ? d : Math.round(straight * 1.25);

  const t = Number(durationMin);
  const okDuration = Number.isFinite(t) && t > 0 && t <= 600;
  const finalDuration = okDuration ? t : (finalDistance / 1000 / DEFAULT_SPEED_KMH) * 60;
  return { distanceMeters: finalDistance, durationMin: Math.round(finalDuration * 10) / 10 };
}

/**
 * Band pricing: first matching band where distanceKm is in [fromKm, toKm).
 * Last band includes upper bound.
 */
function priceFromBands(distanceKm, rule) {
  if (!rule.bands || !rule.bands.length) {
    const distFare = Math.round((distanceKm * (rule.perKmMinor || 0)));
    return (rule.baseFareMinor || 0) + distFare;
  }
  const sorted = [...rule.bands].sort((a, b) => a.fromKm - b.fromKm);
  let fare = sorted[sorted.length - 1].fareMinor;
  for (const band of sorted) {
    const inclusiveMax = band.toKm;
    if (distanceKm >= band.fromKm && distanceKm < inclusiveMax) {
      fare = band.fareMinor;
      break;
    }
    if (distanceKm >= band.fromKm && distanceKm <= inclusiveMax && band === sorted[sorted.length - 1]) {
      fare = band.fareMinor;
    }
  }
  // example 3.4km -> band 3-4 = 240
  for (const band of sorted) {
    if (distanceKm >= band.fromKm && distanceKm <= band.toKm) {
      fare = band.fareMinor;
    }
  }
  return (rule.baseFareMinor || 0) + fare;
}

function applyBounds(amount, rule) {
  let v = amount;
  if (rule.minFareMinor != null) v = Math.max(v, rule.minFareMinor);
  if (rule.maxFareMinor != null) v = Math.min(v, rule.maxFareMinor);
  const surge = rule.surgeMultiplier || 1;
  return Math.round(v * surge);
}

async function calculateTripPrice({
  distanceMeters,
  durationMin = 0,
  stopCount = 0,
  vehicleType = 'basic',
  promoDiscountMinor = 0,
}) {
  const rule = await getActiveRule(vehicleType);
  if (!rule) {
    const err = new Error('No active pricing rule');
    err.code = 'PRICING_NOT_CONFIGURED';
    err.status = 500;
    throw err;
  }
  const distanceKm = distanceMeters / 1000;
  const distanceFareMinor = priceFromBands(distanceKm, rule) - (rule.baseFareMinor || 0);
  const timeFareMinor = Math.round((durationMin || 0) * (rule.perMinuteMinor || 0));
  const stopFareMinor = Math.max(0, stopCount) * (rule.stopFeeMinor || 0);
  const raw = priceFromBands(distanceKm, rule) + timeFareMinor + stopFareMinor;
  const surged = applyBounds(raw, rule);
  const discount = Math.min(promoDiscountMinor || 0, surged);
  const finalPriceMinor = Math.max(0, surged - discount);
  return {
    pricingRuleId: rule._id,
    pricingRuleVersion: rule.version,
    baseFareMinor: rule.baseFareMinor || 0,
    distanceFareMinor,
    timeFareMinor,
    stopFareMinor,
    vehicleType,
    waitingFareMinor: 0,
    discountMinor: discount,
    surgeMultiplier: rule.surgeMultiplier || 1,
    finalPriceMinor,
    cancellationFeeMinor: rule.cancellationFeeMinor || 0,
  };
}

module.exports = {
  calculateTripPrice,
  getActiveRule,
  priceFromBands,
  resolveTripMetrics,
  VEHICLE_TYPES,
};
