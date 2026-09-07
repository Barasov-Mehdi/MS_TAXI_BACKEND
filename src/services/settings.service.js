const { SystemSetting } = require('../models');

const DEFAULTS = {
  defaultDriverRadius: 2000,
  maxDriverRadius: 5000,
  orderQueueActivationDistance: 100,
  maxQueuedOrders: 1,
  driverLocationStaleSeconds: 45,
  maxLocationAccuracyMeters: 80,
  tripCommissionType: 'FIXED',
  tripCommission: 11,
  lowRatingFee: 15,
  ratingThreshold: 3,
  minimumDriverBalance: 0,
  negativeBalanceAllowed: false,
  matchingWeightDistance: 0.45,
  matchingWeightRating: 0.3,
  matchingWeightOnline: 0.1,
  matchingWeightPriority: 0.1,
  matchingWeightActivePenalty: 0.05,
  orderSearchTimeoutSeconds: 120,
  cancellationFeeMinor: 0,
};

let cache = null;
let cacheAt = 0;

async function getSettings() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await SystemSetting.find().lean();
  const map = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  cache = map;
  cacheAt = Date.now();
  return map;
}

function invalidateSettingsCache() {
  cache = null;
}

async function setSetting(key, value) {
  await SystemSetting.findOneAndUpdate({ key }, { value }, { upsert: true });
  invalidateSettingsCache();
  return getSettings();
}

async function seedDefaults() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await SystemSetting.updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }
}

module.exports = { getSettings, setSetting, invalidateSettingsCache, seedDefaults, DEFAULTS };
