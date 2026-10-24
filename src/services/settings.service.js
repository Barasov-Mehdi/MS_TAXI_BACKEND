const { SystemSetting } = require('../models');

const DEFAULTS = {
  defaultDriverRadius: 2000,
  maxDriverRadius: 5000,
  orderQueueActivationDistance: 100,
  maxQueuedOrders: 1,
  driverLocationStaleSeconds: 45,
  maxLocationAccuracyMeters: 80,
  // Sifariş üçün sürücünün koordinatı (GPS ölçməsi) bu qədər saniyədən köhnə olmamalıdır
  driverFixMaxAgeSeconds: 60,

  // Komissiya: sifariş qiymətinin faizi. Reytinq ratingThreshold-dan aşağıdırsa (lowRatingInclusive=true olduqda
  // bərabər də daxil) lowRatingCommission, əks halda tripCommission tutulur.
  tripCommissionType: 'PERCENTAGE',
  tripCommission: 10,
  lowRatingCommission: 15,
  ratingThreshold: 3,
  lowRatingInclusive: true,

  minimumDriverBalance: 0,
  negativeBalanceAllowed: false,
  matchingWeightDistance: 0.45,
  matchingWeightRating: 0.3,
  matchingWeightOnline: 0.1,
  matchingWeightPriority: 0.1,
  matchingWeightActivePenalty: 0.05,
  // Sifariş sürücüyə nə qədər müddət (san) təklif olunur; bitəndə növbəti sürücüyə keçir
  driverOfferSeconds: 20,
  // Təklif bitdikdən sonra şəbəkə gecikməsi üçün qəbula verilən güzəşt (ms)
  offerAcceptGraceMs: 1500,
  // Heç bir sürücü qəbul etməsə, sifariş bu müddətdən (san) sonra ləğv olunur (3 dəqiqə)
  orderDispatchTimeoutSeconds: 180,
  // Uyğun sürücü tapılmadıqda təkrar axtarış intervalı (san)
  dispatchRetrySeconds: 3,
  cancellationFeeMinor: 0,
  // Sürücü qəbul etdiyi sifarişi ləğv edəndə sifariş bu qədər dəfəyə qədər yenidən axtarışa qaytarılır
  maxRedispatch: 5,

  // ---- Sürücü tətbiqi (Android) versiyası: GET /app/version ----
  // Play-ə yeni versiya yüklədikdən sonra admin paneldən (PUT /admin/app-version) yenilənir.
  // latest > cihazdakı versionCode → "Yeni versiya var" (bağlana bilər)
  // min    > cihazdakı versionCode → məcburi yeniləmə (tətbiq bloklanır)
  driverAndroidLatestCode: 3,
  driverAndroidLatestName: '3.0.0',
  driverAndroidMinCode: 1,
  driverAndroidNotes: [],
  driverAndroidStoreUrl: 'https://play.google.com/store/apps/details?id=com.barasdrivers',
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
  // Köhnə default (25 san) bazada qalıbsa, 20 saniyəyə keçir. Admin əl ilə başqa dəyər qoyubsa toxunulmur.
  await SystemSetting.updateOne({ key: 'driverOfferSeconds', value: 25 }, { $set: { value: 20 } });

  // Bir dəfəlik miqrasiya: yeni komissiya siyasəti (reytinq ≤ 3 → 15%, > 3 → 10%).
  // Bayraq qoyulur ki, sonradan admin dəyərləri dəyişsə, restartda təkrar yazılmasın.
  const flag = await SystemSetting.findOne({ key: 'migration_commission_v2' }).lean();
  if (!flag) {
    const policy = {
      tripCommissionType: 'PERCENTAGE',
      tripCommission: 10,
      lowRatingCommission: 15,
      ratingThreshold: 3,
      lowRatingInclusive: true,
    };
    for (const [key, value] of Object.entries(policy)) {
      await SystemSetting.updateOne({ key }, { $set: { key, value } }, { upsert: true });
    }
    await SystemSetting.updateOne(
      { key: 'migration_commission_v2' },
      { $set: { key: 'migration_commission_v2', value: new Date().toISOString() } },
      { upsert: true }
    );
    console.log('[settings] komissiya siyasəti yeniləndi: reytinq ≤ 3 → 15%, > 3 → 10%');
  }
  invalidateSettingsCache();
}

module.exports = { getSettings, setSetting, invalidateSettingsCache, seedDefaults, DEFAULTS };
