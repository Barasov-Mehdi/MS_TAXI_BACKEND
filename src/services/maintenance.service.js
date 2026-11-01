/**
 * Texniki işlər rejimi ("Sistem müvəqqəti dayanıb").
 *
 * Admin (baş admin) yandırır:  PUT /admin/maintenance { enabled: true, message?, until? }
 * Tətbiq oxuyur (girişsiz):     GET /app/status → { maintenance: { enabled, message, until } }
 * Sürücü tətbiqi əlavə olaraq:  GET /drivers/me → { maintenance } (5 saniyəlik sinxronizasiyada da yoxlanılır)
 * Dəyişəndə socket: `maintenance_changed` — müştərilər, sürücülər və admin panel (pəncərə dərhal açılır / bağlanır).
 * Rejim YANANDA / SÖNƏNDƏ onlayn sürücülərə push bildirişi də göndərilir (tətbiq arxa planda ola bilər).
 *
 * Rejim açıq olanda:
 *  - müştəri tətbiqində bütün ekranı örtən "Texniki işlər aparılır" pəncərəsi göstərilir
 *    (aktiv səfəri olan müştəriyə isə yalnız yuxarıda zolaq — səfəri izləməyə mane olmur);
 *  - sürücü tətbiqində şəkilli xəbərdarlıq + daimi zolaq ("yeni sifarişlər müvəqqəti dayandırılıb");
 *  - YENİ sifariş yaratmaq bağlanır (POST /customers/orders → 503 MAINTENANCE);
 *  - aktiv səfərlər, sürücü tətbiqi və admin panel normal işləyir.
 *
 * Heroku-nun öz rejimi (`heroku maintenance:on`) zamanı server heç cavab vermir (503) —
 * tətbiqlər bunu da tanıyır və eyni pəncərəni ümumi mətnlə göstərir.
 */
const { getSettings, setSetting } = require('./settings.service');
const { AppError } = require('../utils/errors');

const MAX_MESSAGE = 300;

function normUntil(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function getStatus() {
  const st = await getSettings();
  return {
    enabled: st.maintenanceEnabled === true,
    message: String(st.maintenanceMessage || ''),
    until: normUntil(st.maintenanceUntil),
  };
}

function broadcast(status) {
  try {
    // eslint-disable-next-line global-require
    const rt = require('../websocket/emitter');
    if (rt.toCustomers) rt.toCustomers('maintenance_changed', status);
    // Bütün qoşulu sürücülər (şəhərdən asılı olmayaraq)
    if (rt.toDrivers) rt.toDrivers(null, 'maintenance_changed', status);
    // Bütün adminlər (regional da) paneldə xəbərdarlıq zolağını görsün
    if (rt.toAdminsFor) rt.toAdminsFor(null, 'maintenance_changed', status);
  } catch (_) { /* səssiz */ }
}

/** Bitmə vaxtı Bakı saatı ilə (push mətni üçün): "14:30" və ya "01.11 14:30". */
function untilLabel(until) {
  if (!until) return '';
  const d = new Date(until);
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) return '';
  const fmt = (opts) => new Intl.DateTimeFormat('az-AZ', { timeZone: 'Asia/Baku', ...opts }).format(d);
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = fmt({ day: '2-digit', month: '2-digit' }) === new Intl.DateTimeFormat('az-AZ', { timeZone: 'Asia/Baku', day: '2-digit', month: '2-digit' }).format(new Date());
  return sameDay ? time : `${fmt({ day: '2-digit', month: '2-digit' })} ${time}`;
}

/**
 * Onlayn sürücülərə push: rejim yandı / söndü. Ardıcıl göndərilir (say adətən kiçikdir), xəta əsas işi pozmur.
 * Gözlənilmir: admin sorğusu push-ları gözləmədən cavab alır.
 */
async function notifyDrivers(status) {
  try {
    // eslint-disable-next-line global-require
    const { Driver } = require('../models');
    // eslint-disable-next-line global-require
    const push = require('./push.service');
    if (!push.sendNotification) return 0;
    const rows = await Driver.find({ isOnline: true, isActive: true, deletedAt: null }).select('_id').lean();
    const until = untilLabel(status.until);
    const title = status.enabled ? 'Sistemdə texniki işlər aparılır' : 'Sistem yenidən işləyir';
    const body = status.enabled
      ? `${status.message || 'Yeni sifarişlər müvəqqəti dayandırılıb. Aktiv səfərlər normal davam edir.'}${until ? ` Təxmini bitmə: ${until}.` : ''}`
      : 'Texniki işlər başa çatdı. Yeni sifarişlər yenidən gəlir.';
    let sent = 0;
    for (const d of rows) {
      // eslint-disable-next-line no-await-in-loop
      const okSent = await push
        .sendNotification(d._id, {
          title,
          body,
          type: 'maintenance',
          channel: 'news',
          tag: 'maintenance',
          data: { enabled: status.enabled ? '1' : '0' },
          ttlMs: 6 * 60 * 60 * 1000,
        })
        .catch(() => false);
      if (okSent) sent += 1;
    }
    return sent;
  } catch (_) {
    return 0;
  }
}

/** Yalnız ötürülən sahələr dəyişir. Söndürəndə mətn və vaxt təmizlənir. */
async function setStatus({ enabled, message, until } = {}) {
  const before = await getStatus();
  if (enabled !== undefined) await setSetting('maintenanceEnabled', enabled === true);
  if (enabled === false) {
    await setSetting('maintenanceMessage', '');
    await setSetting('maintenanceUntil', null);
  } else {
    if (message !== undefined) await setSetting('maintenanceMessage', String(message || '').trim().slice(0, MAX_MESSAGE));
    if (until !== undefined) await setSetting('maintenanceUntil', normUntil(until));
  }
  const status = await getStatus();
  broadcast(status);
  // Push yalnız rejim həqiqətən dəyişəndə (mətni düzəltmək sürücüləri təkrar narahat etməsin)
  if (before.enabled !== status.enabled) notifyDrivers(status);
  return status;
}

/** Express middleware: rejim açıqdırsa 503 MAINTENANCE (yeni sifariş kimi əməliyyatlar üçün). */
function blockDuringMaintenance(req, res, next) {
  getStatus()
    .then((s) => {
      if (!s.enabled) return next();
      return next(new AppError('MAINTENANCE', s.message || 'Sistemdə texniki işlər aparılır', 503, { until: s.until, message: s.message }));
    })
    .catch(() => next());
}

module.exports = { getStatus, setStatus, blockDuringMaintenance, notifyDrivers, untilLabel, MAX_MESSAGE };
