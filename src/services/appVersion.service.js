/**
 * Sürücü tətbiqinin versiya nəzarəti.
 *
 * Tətbiq açılanda (və ön plana qayıdanda) GET /app/version?app=driver&platform=android&versionCode=N çağırır.
 * Cavab:
 *   updateAvailable - Play-də daha yeni versiya var ("Yenilə" / "Sonra")
 *   forceUpdate     - cihazdakı versiya minimumdan aşağıdır: tətbiq yenilənmədən işləməz
 *   notes           - "Nə yenilik var" siyahısı (yeniləmə pəncərəsində və yeniləmədən sonra göstərilir)
 *
 * Dəyərlər SystemSetting-dədir (settings.service DEFAULTS → driverAndroid*), admin PUT /admin/app-version ilə dəyişir.
 */
const { Driver } = require('../models');
const { getSettings, setSetting } = require('./settings.service');

const KEYS = {
  latestCode: 'driverAndroidLatestCode',
  latestName: 'driverAndroidLatestName',
  minCode: 'driverAndroidMinCode',
  notes: 'driverAndroidNotes',
  storeUrl: 'driverAndroidStoreUrl',
};

const toInt = (v, def = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

function normNotes(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
  if (typeof v === 'string') return v.split('\n').map((x) => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 20);
  return [];
}

async function getDriverAndroid() {
  const st = await getSettings();
  const latestCode = toInt(st[KEYS.latestCode], 1);
  return {
    latestVersionCode: latestCode,
    latestVersionName: String(st[KEYS.latestName] || ''),
    // min heç vaxt latest-dən böyük olmasın (səhv ayar bütün sürücüləri bloklamasın)
    minVersionCode: Math.min(toInt(st[KEYS.minCode], 1), latestCode),
    notes: normNotes(st[KEYS.notes]),
    storeUrl: String(st[KEYS.storeUrl] || ''),
  };
}

/** Cihazın versiyasına görə qərar. versionCode məlum deyilsə (0) yalnız məlumat qaytarılır. */
async function check({ versionCode } = {}) {
  const info = await getDriverAndroid();
  const vc = toInt(versionCode, 0);
  return {
    ...info,
    currentVersionCode: vc || null,
    updateAvailable: vc > 0 && vc < info.latestVersionCode,
    forceUpdate: vc > 0 && vc < info.minVersionCode,
  };
}

/**
 * Admin yeni versiyanı qeyd edir. notify=true → köhnə versiyalı sürücülərə push ("Yeni versiya mövcuddur").
 * Qaytarır: yeni məlumat + neçə sürücüyə bildiriş göndərildi.
 */
async function setDriverAndroid({ latestVersionCode, latestVersionName, minVersionCode, notes, storeUrl }, { notify = false } = {}) {
  if (latestVersionCode !== undefined) await setSetting(KEYS.latestCode, toInt(latestVersionCode, 1));
  if (latestVersionName !== undefined) await setSetting(KEYS.latestName, String(latestVersionName || '').trim());
  if (minVersionCode !== undefined) await setSetting(KEYS.minCode, toInt(minVersionCode, 1));
  if (notes !== undefined) await setSetting(KEYS.notes, normNotes(notes));
  if (storeUrl !== undefined) await setSetting(KEYS.storeUrl, String(storeUrl || '').trim());
  const info = await getDriverAndroid();

  // Açıq tətbiqlər dərhal yoxlasın (yeniləmə pəncərəsi gözləmədən çıxsın)
  try {
    // eslint-disable-next-line global-require
    require('../websocket/emitter').toDrivers(null, 'app_version_changed', {
      latestVersionCode: info.latestVersionCode,
      minVersionCode: info.minVersionCode,
    });
  } catch (_) { /* səssiz */ }

  let notified = 0;
  if (notify) {
    // eslint-disable-next-line global-require
    const push = require('./push.service');
    const outdated = await Driver.find({
      deletedAt: null,
      isActive: true,
      $or: [{ appVersionCode: { $lt: info.latestVersionCode } }, { appVersionCode: null }],
    })
      .select('_id')
      .lean();
    for (const d of outdated) {
      // eslint-disable-next-line no-await-in-loop
      const sent = await push.notifyAppUpdate(d._id, info).catch(() => false);
      if (sent) notified += 1;
    }
  }
  return { ...info, notified };
}

/** Sürücünün cihazdakı versiyasını yadda saxlayır (device-token və /app/version ilə gəlir). */
async function rememberDriverVersion(driverId, { versionCode, versionName } = {}) {
  const vc = toInt(versionCode, 0);
  if (!driverId || !vc) return;
  await Driver.updateOne(
    { _id: driverId },
    { $set: { appVersionCode: vc, appVersionName: versionName ? String(versionName).slice(0, 30) : null } }
  ).catch(() => {});
}

module.exports = { check, getDriverAndroid, setDriverAndroid, rememberDriverVersion, normNotes };
