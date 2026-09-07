const { PricingRule } = require('../models');

async function getActiveRule() {
  const rule = await PricingRule.findOne({ active: true }).sort({ updatedAt: -1 });
  return rule;
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

async function calculateTripPrice({ distanceMeters, promoDiscountMinor = 0 }) {
  const rule = await getActiveRule();
  if (!rule) {
    const err = new Error('No active pricing rule');
    err.code = 'PRICING_NOT_CONFIGURED';
    err.status = 500;
    throw err;
  }
  const distanceKm = distanceMeters / 1000;
  const distanceFareMinor = priceFromBands(distanceKm, rule) - (rule.baseFareMinor || 0);
  const raw = priceFromBands(distanceKm, rule);
  const surged = applyBounds(raw, rule);
  const discount = Math.min(promoDiscountMinor || 0, surged);
  const finalPriceMinor = Math.max(0, surged - discount);
  return {
    pricingRuleId: rule._id,
    pricingRuleVersion: rule.version,
    baseFareMinor: rule.baseFareMinor || 0,
    distanceFareMinor,
    timeFareMinor: 0,
    waitingFareMinor: 0,
    discountMinor: discount,
    surgeMultiplier: rule.surgeMultiplier || 1,
    finalPriceMinor,
    cancellationFeeMinor: rule.cancellationFeeMinor || 0,
  };
}

module.exports = { calculateTripPrice, getActiveRule, priceFromBands };
