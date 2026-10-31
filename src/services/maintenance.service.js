/**
 * Texniki işlər rejimi ("Sistem müvəqqəti dayanıb").
 *
 * Admin (baş admin) yandırır:  PUT /admin/maintenance { enabled: true, message?, until? }
 * Tətbiq oxuyur (girişsiz):     GET /app/status → { maintenance: { enabled, message, until } }
 * Dəyişəndə açıq müştəri tətbiqlərinə socket: `maintenance_changed` (pəncərə dərhal açılır / bağlanır).
 *
 * Rejim açıq olanda:
 *  - müştəri tətbiqində bütün ekranı örtən "Texniki işlər aparılır" pəncərəsi göstərilir
 *    (aktiv səfəri olan müştəriyə isə yalnız yuxarıda zolaq — səfəri izləməyə mane olmur);
 *  - YENİ sifariş yaratmaq bağlanır (POST /customers/orders → 503 MAINTENANCE);
 *  - aktiv səfərlər, sürücü tətbiqi və admin panel normal işləyir.
 *
 * Heroku-nun öz rejimi (`heroku maintenance:on`) zamanı server heç cavab vermir (503) —
 * tətbiq bunu da tanıyır və eyni pəncərəni ümumi mətnlə göstərir.
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
    // Bütün adminlər (regional da) paneldə xəbərdarlıq zolağını görsün
    if (rt.toAdminsFor) rt.toAdminsFor(null, 'maintenance_changed', status);
  } catch (_) { /* səssiz */ }
}

/** Yalnız ötürülən sahələr dəyişir. Söndürəndə mətn və vaxt təmizlənir. */
async function setStatus({ enabled, message, until } = {}) {
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

module.exports = { getStatus, setStatus, blockDuringMaintenance, MAX_MESSAGE };
