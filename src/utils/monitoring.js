/**
 * Xəta izləmə (Sentry) — istəyə bağlı. SENTRY_DSN təyin edilibsə 5xx xətaları və tutulmamış istisnalar Sentry-yə
 * göndərilir. Paket və ya DSN yoxdursa heç nə etmir (yalnız konsol logu).
 */
let sentry = null;

function init() {
  if (!process.env.SENTRY_DSN || sentry) return sentry;
  try {
    // eslint-disable-next-line global-require
    sentry = require('@sentry/node');
    sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.HEROKU_SLUG_COMMIT || process.env.SOURCE_VERSION || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.05),
    });
    console.log('[monitoring] Sentry aktivdir');
  } catch (e) {
    console.error('[monitoring] Sentry qoşulmadı:', e && e.message);
    sentry = null;
  }
  return sentry;
}

function captureException(err, context) {
  if (!sentry) return;
  try {
    sentry.captureException(err, context ? { extra: context } : undefined);
  } catch (_) { /* yox */ }
}

async function flush(ms = 2000) {
  if (sentry && sentry.flush) await sentry.flush(ms).catch(() => {});
}

module.exports = { init, captureException, flush };
