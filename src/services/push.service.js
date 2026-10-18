/**
 * FCM push (yalnız data mesajı, yüksək prioritet).
 *
 * Məqsəd: sürücünün tətbiqi arxa planda / ekran kilidli / proses öldürülmüş olanda belə
 * yeni sifariş təklifi telefona çatsın və Android tərəfi tam ekran sifariş pəncərəsi açsın.
 * Socket.IO yalnız tətbiq canlı olanda işləyir; push onun üzərinə əlavə (ehtiyat) kanaldır.
 *
 * Konfiqurasiya (Heroku Config Vars) - birini seçin:
 *   FIREBASE_SERVICE_ACCOUNT_B64  - service account JSON-un base64 forması (tövsiyə olunur)
 *   FIREBASE_SERVICE_ACCOUNT      - service account JSON (düz mətn)
 * Təyin edilməyibsə push söndürülür, qalan sistem əvvəlki kimi işləyir.
 */
const { Driver } = require('../models');

let messaging = null;
let initTried = false;

/**
 * Açar dəyərini JSON obyektinə çevirir. Qəbul olunan formatlar:
 *  - düz JSON ( { ... } )
 *  - base64 ilə kodlanmış JSON
 *  - ətrafında dırnaq olan yuxarıdakılardan biri
 */
function parseServiceAccount(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
  if (!v.startsWith('{')) v = Buffer.from(v, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  const cred = JSON.parse(v);
  if (cred.private_key) cred.private_key = String(cred.private_key).replace(/\\n/g, '\n');
  if (!cred.project_id || !cred.client_email || !cred.private_key) {
    throw new Error('service account JSON natamamdır (project_id / client_email / private_key)');
  }
  return cred;
}

function init() {
  if (initTried) return messaging;
  initTried = true;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      console.warn('[push] FIREBASE_SERVICE_ACCOUNT(_B64) təyin edilməyib: push söndürülüb');
      return null;
    }
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    const cred = parseServiceAccount(raw);
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(cred) });
    messaging = admin.messaging(app);
    console.log('[push] Firebase hazırdır, layihə:', cred.project_id);
  } catch (e) {
    console.error('[push] Firebase init alınmadı:', e && e.message ? e.message : e);
    messaging = null;
  }
  return messaging;
}

const str = (v) => (v === undefined || v === null ? '' : String(v));

async function sendToDriver(driverId, data, { ttlMs = 30000 } = {}) {
  const m = init();
  if (!m || !driverId) return false;
  const driver = await Driver.findById(driverId).select('+fcmToken').lean();
  if (!driver || !driver.fcmToken) return false;
  try {
    await m.send({
      token: driver.fcmToken,
      data,
      android: {
        priority: 'high', // Doze rejimində də dərhal çatdırılsın
        ttl: Math.max(1000, ttlMs), // təklif bitəndən sonra köhnə push çatdırılmasın
        collapseKey: 'taxi_offer',
      },
    });
    return true;
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument')) {
      // Token ölüdür (tətbiq silinib / yenilənib): təmizlə
      await Driver.updateOne({ _id: driverId, fcmToken: driver.fcmToken }, { $set: { fcmToken: null } }).catch(() => {});
    } else {
      console.error('[push] göndərilmədi:', code || (e && e.message));
    }
    return false;
  }
}

/** Yeni təklif: payload dispatch.service.buildOfferPayload ilə eynidir. */
function sendOffer(driverId, payload) {
  const expires = payload.offerExpiresAt ? new Date(payload.offerExpiresAt).getTime() : Date.now() + 20000;
  const ttlMs = Math.max(1000, expires - Date.now());
  const pickup = payload.pickup || {};
  const dest = payload.destination || {};
  return sendToDriver(
    driverId,
    {
      type: 'new_order',
      orderId: str(payload.orderId),
      priceMinor: str(payload.priceMinor),
      distanceMeters: str(payload.distanceMeters),
      distanceToPickupMeters: str(payload.distanceToPickupMeters),
      pickupAddress: str(payload.pickupAddress || pickup.address),
      destinationAddress: str(payload.destinationAddress || dest.address),
      pickupLat: str(pickup.coordinates && pickup.coordinates[1]),
      pickupLng: str(pickup.coordinates && pickup.coordinates[0]),
      destLat: str(dest.coordinates && dest.coordinates[1]),
      destLng: str(dest.coordinates && dest.coordinates[0]),
      paymentMethod: str(payload.paymentMethod),
      queued: payload.queued ? '1' : '0',
      offerExpiresAt: payload.offerExpiresAt ? new Date(payload.offerExpiresAt).toISOString() : '',
      serverTime: payload.serverTime ? new Date(payload.serverTime).toISOString() : new Date().toISOString(),
    },
    { ttlMs }
  );
}

/** Təklif bitdi / başqasına keçdi / sifariş ləğv oldu: açıq tam ekran pəncərəni bağlat. */
function sendOfferEnded(driverId, orderId, reason) {
  return sendToDriver(driverId, { type: 'offer_cancel', orderId: str(orderId), reason: str(reason) }, { ttlMs: 20000 });
}

module.exports = { sendOffer, sendOfferEnded, sendToDriver };