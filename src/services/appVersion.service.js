/**
 * Tətbiq versiya nəzarəti: sürücü (app=driver) və müştəri (app=customer) tətbiqləri, Android və iOS.
 *
 * Tətbiq açılanda (və ön plana qayıdanda) çağırır:
 *   GET /app/version?app=driver|customer&platform=android|ios&versionCode=N
 *     Android: versionCode = build.gradle → versionCode
 *     iOS:     versionCode = Info.plist → CFBundleVersion (build nömrəsi, tam ədəd: 1, 2, 3 ...)
 * Cavab:
 *   updateAvailable - mağazada daha yeni versiya var ("Yenilə" / "Sonra")
 *   forceUpdate     - cihazdakı versiya minimumdan aşağıdır: tətbiq yenilənmədən işləməz
 *   notes           - "Nə yenilik var" siyahısı
 *   storeUrl        - Play Store / App Store linki
 *
 * Dəyərlər SystemSetting-dədir (settings.service DEFAULTS → driverAndroid*, driverIos*, customerAndroid*, customerIos*),
 * admin PUT /admin/app-version { app, platform, ... } ilə dəyişir.
 * notify=true → həmin platformada köhnə versiyalı istifadəçilərə push + açıq tətbiqlərə socket.
 */
const { Driver, Customer } = require('../models');
const { getSettings, setSetting } = require('./settings.service');

const APP_NAMES = ['driver', 'customer'];
const PLATFORMS = ['android', 'ios'];
const isApp = (app) => APP_NAMES.includes(app);
const isPlatform = (p) => PLATFORMS.includes(p);
const normApp = (app) => (isApp(app) ? app : 'driver');
const normPlatform = (p) => (isPlatform(p) ? p : 'android');

/** Ayar açarları: driverAndroidLatestCode, driverIosLatestCode, customerIosNotes ... */
function keysOf(app, platform) {
  const p = normPlatform(platform) === 'ios' ? 'Ios' : 'Android';
  const prefix = `${normApp(app)}${p}`;
  return {
    latestCode: `${prefix}LatestCode`,
    latestName: `${prefix}LatestName`,
    minCode: `${prefix}MinCode`,
    notes: `${prefix}Notes`,
    storeUrl: `${prefix}StoreUrl`,
  };
}

const toInt = (v, def = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

function normNotes(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
  if (typeof v === 'string') return v.split('\n').map((x) => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 20);
  return [];
}

async function getInfo(app = 'driver', platform = 'android') {
  const K = keysOf(app, platform);
  const st = await getSettings();
  const latestCode = toInt(st[K.latestCode], 1);
  return {
    app: normApp(app),
    platform: normPlatform(platform),
    latestVersionCode: latestCode,
    latestVersionName: String(st[K.latestName] || ''),
    // min heç vaxt latest-dən böyük olmasın (səhv ayar bütün istifadəçiləri bloklamasın)
    minVersionCode: Math.min(toInt(st[K.minCode], 1), latestCode),
    notes: normNotes(st[K.notes]),
    storeUrl: String(st[K.storeUrl] || ''),
  };
}

/** Cihazın versiyasına görə qərar. versionCode məlum deyilsə (0) yalnız məlumat qaytarılır. */
async function check({ app = 'driver', platform = 'android', versionCode } = {}) {
  const info = await getInfo(app, platform);
  const vc = toInt(versionCode, 0);
  return {
    ...info,
    currentVersionCode: vc || null,
    updateAvailable: vc > 0 && vc < info.latestVersionCode,
    forceUpdate: vc > 0 && vc < info.minVersionCode,
  };
}

// ---------------------------------------------------------------- Bildiriş mətnləri (müştəri dilinə görə)

const UPDATE_TEXT = {
  az: { title: (n) => `Yeni versiya${n} mövcuddur`, body: 'Tətbiqi yeniləyin: yeni imkanlar və düzəlişlər.' },
  ru: { title: (n) => `Доступна новая версия${n}`, body: 'Обновите приложение: новые возможности и исправления.' },
  en: { title: (n) => `New version${n} available`, body: 'Update the app to get new features and fixes.' },
  tr: { title: (n) => `Yeni sürüm${n} mevcut`, body: 'Yeni özellikler ve düzeltmeler için uygulamayı güncelleyin.' },
};

function updateText(info, lang) {
  const t = UPDATE_TEXT[lang] || UPDATE_TEXT.az;
  const name = info && info.latestVersionName ? ` ${info.latestVersionName}` : '';
  const notes = info && Array.isArray(info.notes) && info.notes.length ? info.notes.slice(0, 3).join(' • ') : '';
  return { title: t.title(name), body: notes || t.body };
}

/**
 * Köhnə (və ya versiyası bilinməyən) istifadəçilər, yalnız həmin platformada.
 * Platforması yazılmamış köhnə qeydlər Android sayılır (iOS dəstəyindən əvvəl yalnız Android var idi).
 */
function outdatedQuery(info) {
  const platformQ = info.platform === 'ios'
    ? { appPlatform: 'ios' }
    : { appPlatform: { $in: ['android', null] } };
  const versionQ = { $or: [{ appVersionCode: { $lt: info.latestVersionCode } }, { appVersionCode: null }] };
  return { $and: [platformQ, versionQ] };
}

/** Sürücülərə push (ardıcıl; say qaytarılır). */
async function notifyDrivers(info) {
  // eslint-disable-next-line global-require
  const push = require('./push.service');
  const outdated = await Driver.find({ deletedAt: null, isActive: true, ...outdatedQuery(info) })
    .select('_id')
    .lean();
  let notified = 0;
  for (const d of outdated) {
    // eslint-disable-next-line no-await-in-loop
    const sent = await push.notifyAppUpdate(d._id, info).catch(() => false);
    if (sent) notified += 1;
  }
  return notified;
}

/**
 * Müştərilərə push. Say çox ola bilər: `concurrency` qədər eyni anda göndərilir.
 * wait=false → arxa planda göndərilir (admin sorğusu gözləmir), cavabda hədəf sayı qaytarılır.
 */
async function notifyCustomers(info, { wait = false, concurrency = 10 } = {}) {
  // eslint-disable-next-line global-require
  const push = require('./push.service');
  const targets = await Customer.find({ fcmToken: { $ne: null }, ...outdatedQuery(info) })
    .select('_id language')
    .lean();

  const run = async () => {
    let sent = 0;
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const c = targets[i++];
        const { title, body } = updateText(info, c.language);
        // eslint-disable-next-line no-await-in-loop
        const ok = await push
          .sendToCustomer(c._id, {
            title,
            body,
            type: 'app_update',
            channel: 'app',
            tag: 'app_update',
            data: { versionCode: info.latestVersionCode, storeUrl: info.storeUrl, platform: info.platform },
            ttlMs: 3 * 24 * 60 * 60 * 1000,
          })
          .catch(() => false);
        if (ok) sent += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
    return sent;
  };

  if (wait) return { targets: targets.length, notified: await run() };
  run()
    .then((n) => console.log(`[appVersion] müştərilərə (${info.platform}) yeniləmə bildirişi: ${n}/${targets.length}`))
    .catch((e) => console.error('[appVersion] müştəri bildirişi alınmadı', e && e.message));
  return { targets: targets.length, notified: null };
}

/** Açıq tətbiqlər dərhal yoxlasın (yeniləmə pəncərəsi gözləmədən çıxsın). Tətbiq öz platformasını yoxlayır. */
function broadcast(info) {
  try {
    // eslint-disable-next-line global-require
    const rt = require('../websocket/emitter');
    const payload = {
      app: info.app,
      platform: info.platform,
      latestVersionCode: info.latestVersionCode,
      minVersionCode: info.minVersionCode,
    };
    if (info.app === 'customer') {
      if (rt.toCustomers) rt.toCustomers('app_version_changed', payload);
    } else {
      rt.toDrivers(null, 'app_version_changed', payload);
    }
  } catch (_) { /* səssiz */ }
}

/** Köhnə versiyalı istifadəçilərə bildiriş (versiyanı dəyişmədən təkrar göndərmək üçün də). */
async function notifyOutdated(app = 'driver', platform = 'android', opts = {}) {
  const info = await getInfo(app, platform);
  if (info.app === 'customer') return notifyCustomers(info, opts);
  return { notified: await notifyDrivers(info) };
}

/**
 * Admin yeni versiyanı qeyd edir (bir platforma üçün). notify=true → həmin platformada köhnə versiyalılara push.
 */
async function setInfo(
  app,
  { platform = 'android', latestVersionCode, latestVersionName, minVersionCode, notes, storeUrl },
  { notify = false, wait = false } = {}
) {
  const K = keysOf(app, platform);
  if (latestVersionCode !== undefined) await setSetting(K.latestCode, toInt(latestVersionCode, 1));
  if (latestVersionName !== undefined) await setSetting(K.latestName, String(latestVersionName || '').trim());
  if (minVersionCode !== undefined) await setSetting(K.minCode, toInt(minVersionCode, 1));
  if (notes !== undefined) await setSetting(K.notes, normNotes(notes));
  if (storeUrl !== undefined) await setSetting(K.storeUrl, String(storeUrl || '').trim());
  const info = await getInfo(app, platform);
  broadcast(info);

  let result = { notified: 0 };
  if (notify) {
    result = info.app === 'customer' ? await notifyCustomers(info, { wait }) : { notified: await notifyDrivers(info) };
  }
  return { ...info, ...result };
}

// ---------------------------------------------------------------- Köhnə adlar (uyğunluq)

const getDriverAndroid = () => getInfo('driver', 'android');
const setDriverAndroid = (data, opts) => setInfo('driver', { ...data, platform: 'android' }, opts);

function versionFields({ versionCode, versionName, platform } = {}) {
  const vc = toInt(versionCode, 0);
  if (!vc) return null;
  const set = { appVersionCode: vc, appVersionName: versionName ? String(versionName).slice(0, 30) : null };
  if (isPlatform(platform)) set.appPlatform = platform;
  return set;
}

/** Sürücünün cihazdakı versiyası (device-token və /app/version ilə gəlir). */
async function rememberDriverVersion(driverId, v = {}) {
  const set = versionFields(v);
  if (!driverId || !set) return;
  await Driver.updateOne({ _id: driverId }, { $set: set }).catch(() => {});
}

/** Müştərinin cihazdakı versiyası (/app/version girişlə çağırılanda və /customers/fcm-token ilə gəlir). */
async function rememberCustomerVersion(customerId, v = {}) {
  const set = versionFields(v);
  if (!customerId || !set) return;
  await Customer.updateOne({ _id: customerId }, { $set: set }).catch(() => {});
}

/** Admin paneli üçün statistika (bir tətbiq + platforma). */
async function stats(app = 'driver', platform = 'android') {
  const info = await getInfo(app, platform);
  const Model = info.app === 'customer' ? Customer : Driver;
  const base = info.app === 'customer' ? {} : { deletedAt: null };
  const plat = info.platform === 'ios' ? { appPlatform: 'ios' } : { appPlatform: { $in: ['android', null] } };
  const [outdated, reported, unknownWithPush] = await Promise.all([
    Model.countDocuments({ ...base, ...plat, appVersionCode: { $lt: info.latestVersionCode } }),
    Model.countDocuments({ ...base, ...plat, appVersionCode: { $ne: null } }),
    Model.countDocuments({ ...base, ...plat, appVersionCode: null, fcmToken: { $ne: null } }),
  ]);
  return { ...info, users: { reported, outdated, unknownWithPush } };
}

module.exports = {
  APP_NAMES,
  PLATFORMS,
  isApp,
  isPlatform,
  check,
  getInfo,
  setInfo,
  stats,
  notifyOutdated,
  getDriverAndroid,
  setDriverAndroid,
  rememberDriverVersion,
  rememberCustomerVersion,
  normNotes,
  updateText,
};
