/**
 * Tətbiq versiya nəzarəti: sürücü tətbiqi (app=driver) və müştəri tətbiqi (app=customer), Android.
 *
 * Tətbiq açılanda (və ön plana qayıdanda) GET /app/version?app=driver|customer&platform=android&versionCode=N çağırır.
 * Cavab:
 *   updateAvailable - Play-də daha yeni versiya var ("Yenilə" / "Sonra")
 *   forceUpdate     - cihazdakı versiya minimumdan aşağıdır: tətbiq yenilənmədən işləməz
 *   notes           - "Nə yenilik var" siyahısı
 *
 * Dəyərlər SystemSetting-dədir (settings.service DEFAULTS → driverAndroid* / customerAndroid*),
 * admin PUT /admin/app-version { app: 'driver' | 'customer', ... } ilə dəyişir.
 * notify=true → köhnə versiyalı istifadəçilərə push ("Yeni versiya mövcuddur") + açıq tətbiqlərə socket.
 */
const { Driver, Customer } = require('../models');
const { getSettings, setSetting } = require('./settings.service');

const APPS = {
  driver: {
    latestCode: 'driverAndroidLatestCode',
    latestName: 'driverAndroidLatestName',
    minCode: 'driverAndroidMinCode',
    notes: 'driverAndroidNotes',
    storeUrl: 'driverAndroidStoreUrl',
  },
  customer: {
    latestCode: 'customerAndroidLatestCode',
    latestName: 'customerAndroidLatestName',
    minCode: 'customerAndroidMinCode',
    notes: 'customerAndroidNotes',
    storeUrl: 'customerAndroidStoreUrl',
  },
};

const APP_NAMES = Object.keys(APPS);
const isApp = (app) => APP_NAMES.includes(app);
const keysOf = (app) => APPS[isApp(app) ? app : 'driver'];

const toInt = (v, def = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

function normNotes(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
  if (typeof v === 'string') return v.split('\n').map((x) => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 20);
  return [];
}

async function getInfo(app = 'driver') {
  const K = keysOf(app);
  const st = await getSettings();
  const latestCode = toInt(st[K.latestCode], 1);
  return {
    app: isApp(app) ? app : 'driver',
    latestVersionCode: latestCode,
    latestVersionName: String(st[K.latestName] || ''),
    // min heç vaxt latest-dən böyük olmasın (səhv ayar bütün istifadəçiləri bloklamasın)
    minVersionCode: Math.min(toInt(st[K.minCode], 1), latestCode),
    notes: normNotes(st[K.notes]),
    storeUrl: String(st[K.storeUrl] || ''),
  };
}

/** Cihazın versiyasına görə qərar. versionCode məlum deyilsə (0) yalnız məlumat qaytarılır. */
async function check({ app = 'driver', versionCode } = {}) {
  const info = await getInfo(app);
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

/** Köhnə (və ya versiyası bilinməyən) istifadəçilərin sorğusu. */
const outdatedQuery = (latest) => ({ $or: [{ appVersionCode: { $lt: latest } }, { appVersionCode: null }] });

/** Sürücülərə push (ardıcıl; say qaytarılır). */
async function notifyDrivers(info) {
  // eslint-disable-next-line global-require
  const push = require('./push.service');
  const outdated = await Driver.find({ deletedAt: null, isActive: true, ...outdatedQuery(info.latestVersionCode) })
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
 * Müştərilərə push. Say çox ola bilər: hamısı paralel deyil, `concurrency` qədər eyni anda göndərilir.
 * wait=false → arxa planda göndərilir (admin sorğusu gözləmir), cavabda hədəf sayı qaytarılır.
 */
async function notifyCustomers(info, { wait = false, concurrency = 10 } = {}) {
  // eslint-disable-next-line global-require
  const push = require('./push.service');
  const targets = await Customer.find({ fcmToken: { $ne: null }, ...outdatedQuery(info.latestVersionCode) })
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
            data: { versionCode: info.latestVersionCode, storeUrl: info.storeUrl },
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
    .then((n) => console.log(`[appVersion] müştərilərə yeniləmə bildirişi: ${n}/${targets.length}`))
    .catch((e) => console.error('[appVersion] müştəri bildirişi alınmadı', e && e.message));
  return { targets: targets.length, notified: null };
}

/** Açıq tətbiqlər dərhal yoxlasın (yeniləmə pəncərəsi gözləmədən çıxsın). */
function broadcast(info) {
  try {
    // eslint-disable-next-line global-require
    const rt = require('../websocket/emitter');
    const payload = { app: info.app, latestVersionCode: info.latestVersionCode, minVersionCode: info.minVersionCode };
    if (info.app === 'customer') {
      if (rt.toCustomers) rt.toCustomers('app_version_changed', payload);
    } else {
      rt.toDrivers(null, 'app_version_changed', payload);
    }
  } catch (_) { /* səssiz */ }
}

/** Köhnə versiyalı istifadəçilərə bildiriş (versiyanı dəyişmədən təkrar göndərmək üçün də). */
async function notifyOutdated(app = 'driver', opts = {}) {
  const info = await getInfo(app);
  if (info.app === 'customer') return notifyCustomers(info, opts);
  return { notified: await notifyDrivers(info) };
}

/**
 * Admin yeni versiyanı qeyd edir. notify=true → köhnə versiyalı istifadəçilərə push.
 * Qaytarır: yeni məlumat + bildiriş nəticəsi.
 */
async function setInfo(app, { latestVersionCode, latestVersionName, minVersionCode, notes, storeUrl }, { notify = false, wait = false } = {}) {
  const K = keysOf(app);
  if (latestVersionCode !== undefined) await setSetting(K.latestCode, toInt(latestVersionCode, 1));
  if (latestVersionName !== undefined) await setSetting(K.latestName, String(latestVersionName || '').trim());
  if (minVersionCode !== undefined) await setSetting(K.minCode, toInt(minVersionCode, 1));
  if (notes !== undefined) await setSetting(K.notes, normNotes(notes));
  if (storeUrl !== undefined) await setSetting(K.storeUrl, String(storeUrl || '').trim());
  const info = await getInfo(app);
  broadcast(info);

  let result = { notified: 0 };
  if (notify) {
    result = info.app === 'customer' ? await notifyCustomers(info, { wait }) : { notified: await notifyDrivers(info) };
  }
  return { ...info, ...result };
}

// ---------------------------------------------------------------- Köhnə adlar (uyğunluq)

const getDriverAndroid = () => getInfo('driver');
const setDriverAndroid = (data, opts) => setInfo('driver', data, opts);

/** Sürücünün cihazdakı versiyasını yadda saxlayır (device-token və /app/version ilə gəlir). */
async function rememberDriverVersion(driverId, { versionCode, versionName } = {}) {
  const vc = toInt(versionCode, 0);
  if (!driverId || !vc) return;
  await Driver.updateOne(
    { _id: driverId },
    { $set: { appVersionCode: vc, appVersionName: versionName ? String(versionName).slice(0, 30) : null } }
  ).catch(() => {});
}

/** Müştərinin cihazdakı versiyası (/app/version girişlə çağırılanda və /customers/fcm-token ilə gəlir). */
async function rememberCustomerVersion(customerId, { versionCode, versionName } = {}) {
  const vc = toInt(versionCode, 0);
  if (!customerId || !vc) return;
  await Customer.updateOne(
    { _id: customerId },
    { $set: { appVersionCode: vc, appVersionName: versionName ? String(versionName).slice(0, 30) : null } }
  ).catch(() => {});
}

/** Admin paneli üçün statistika: neçə istifadəçi versiyasını bildirib, neçəsi köhnədir. */
async function stats(app = 'driver') {
  const info = await getInfo(app);
  const Model = info.app === 'customer' ? Customer : Driver;
  const base = info.app === 'customer' ? {} : { deletedAt: null };
  const [outdated, reported, unknownWithPush] = await Promise.all([
    Model.countDocuments({ ...base, appVersionCode: { $lt: info.latestVersionCode } }),
    Model.countDocuments({ ...base, appVersionCode: { $ne: null } }),
    Model.countDocuments({ ...base, appVersionCode: null, fcmToken: { $ne: null } }),
  ]);
  return { ...info, users: { reported, outdated, unknownWithPush } };
}

module.exports = {
  APP_NAMES,
  isApp,
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
