/**
 * Ortaq Redis bağlantısı (istəyə bağlı). REDIS_URL redis:// və ya rediss:// ilə başlayırsa aktivdir.
 * İstifadə: Socket.IO adapter (çox instansiya), rate-limit sayğacları, lider kilidi, yaxın sürücü keşi.
 * Redis yoxdursa (və ya paket yoxdursa) hər şey tək instansiya rejimində işləyir.
 */
let client = null;
let tried = false;

const url = () => process.env.REDIS_URL || '';
const enabled = () => /^rediss?:\/\//i.test(url());

function socketOptions() {
  if (!url().startsWith('rediss://')) return {};
  // Heroku Redis öz-özünə imzalanmış sertifikat istifadə edir
  return { tls: true, rejectUnauthorized: process.env.REDIS_TLS_INSECURE !== 'true' };
}

/** Əsas klient (əmrlər üçün). Bağlantı arxa planda qurulur, əmrlər növbədə gözləyir. */
function getClient() {
  if (tried) return client;
  tried = true;
  if (!enabled()) return null;
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require('redis');
    client = createClient({ url: url(), socket: { ...socketOptions(), reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
    client.on('error', (e) => console.error('[redis]', e && e.message));
    client.connect().catch((e) => console.error('[redis] qoşulmadı:', e && e.message));
  } catch (e) {
    console.error('[redis] paket yoxdur və ya xəta:', e && e.message);
    client = null;
  }
  return client;
}

/** Yeni ayrıca klient (pub/sub üçün). */
function createExtraClient() {
  if (!enabled()) return null;
  // eslint-disable-next-line global-require
  const { createClient } = require('redis');
  const c = createClient({ url: url(), socket: socketOptions() });
  c.on('error', (e) => console.error('[redis]', e && e.message));
  return c;
}

const isReady = () => !!(client && client.isReady);

async function close() {
  if (client) await client.quit().catch(() => {});
}

module.exports = { enabled, getClient, createExtraClient, isReady, close };
