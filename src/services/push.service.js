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
 *
 * İki cür mesaj var:
 *  1) DATA-only (new_order / offer_cancel): tam ekran sifariş pəncərəsi üçün, native servis özü işləyir.
 *  2) BİLDİRİŞ (notification + data): çat mesajı, ləğv, növbə, balans, hesab. Tətbiq arxa planda / bağlı olanda
 *     sistem özü bildirişi göstərir; toxunanda Android `NotificationTapActivity` açılır və tətbiq
 *     `taxidriver://n/...` linki ilə uyğun ekrana yönləndirilir. Tətbiq ÖN PLANDA olanda sistem bildiriş göstərmir
 *     (socket hadisəsi + tətbiqdaxili banner işləyir) - təkrar bildiriş olmur.
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

/** FCM xətasında ölü tokeni təmizləyir. */
async function handleSendError(driverId, token, e) {
  const code = e && e.code ? String(e.code) : '';
  if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument')) {
    // Token ölüdür (tətbiq silinib / yenilənib): təmizlə
    await Driver.updateOne({ _id: driverId, fcmToken: token }, { $set: { fcmToken: null } }).catch(() => {});
  } else {
    console.error('[push] göndərilmədi:', code || (e && e.message));
  }
}

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
    await handleSendError(driverId, driver.fcmToken, e);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Bildirişlər (notification + data)
// ---------------------------------------------------------------------------------------------

/** Android bildiriş kanalları: android/.../notify/NotifyInitProvider.kt ilə EYNİ id-lər olmalıdır. */
const CHANNEL = {
  chat: 'chat_messages',
  trip: 'trip_updates',
  wallet: 'wallet_updates',
  account: 'account_updates',
};

/** Toxunanda açılacaq aktivitenin intent action-ı (AndroidManifest-dəki intent-filter ilə eyni). */
const CLICK_ACTION = 'com.taxidriverapp.NOTIFICATION_TAP';

const clip = (v, n) => {
  const t = str(v).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const azn = (minor) => `${(Number(minor || 0) / 100).toFixed(2)} ₼`;

/**
 * Ümumi bildiriş göndərişi.
 *  type    - tətbiq tərəfində yönləndirmə üçün (chat_message, order_cancelled, ...)
 *  channel - CHANNEL açarı (səs/əhəmiyyət dərəcəsi)
 *  tag     - eyni tag-lı yeni bildiriş köhnəni əvəz edir (məs. bir sifarişin çatı bir bildiriş olur)
 */
async function sendNotification(driverId, { title, body, type, channel = 'trip', data = {}, tag, ttlMs = 60 * 60 * 1000 }) {
  const m = init();
  if (!m || !driverId) return false;
  const driver = await Driver.findById(driverId).select('+fcmToken').lean();
  if (!driver || !driver.fcmToken) return false;

  const payload = { type: str(type) };
  for (const [k, v] of Object.entries(data)) payload[k] = str(v); // FCM data dəyərləri yalnız string ola bilər

  try {
    await m.send({
      token: driver.fcmToken,
      notification: { title: clip(title, 80), body: clip(body, 180) },
      data: payload,
      android: {
        priority: 'high',
        ttl: Math.max(1000, ttlMs),
        notification: {
          channelId: CHANNEL[channel] || CHANNEL.trip,
          clickAction: CLICK_ACTION,
          sound: 'default',
          defaultVibrateTimings: true,
          ...(tag ? { tag: String(tag).slice(0, 100) } : {}),
        },
      },
    });
    return true;
  } catch (e) {
    await handleSendError(driverId, driver.fcmToken, e);
    return false;
  }
}

/** Sərnişindən yeni çat mesajı. Bir sifarişin mesajları eyni bildirişin üzərinə yazılır (tag). */
function notifyChatMessage(driverId, { orderId, messageId, senderName, text }) {
  return sendNotification(driverId, {
    title: clip(senderName, 40) || 'Sərnişin',
    body: text,
    type: 'chat_message',
    channel: 'chat',
    tag: `chat_${orderId}`,
    data: { orderId, messageId },
  });
}

/** Ofisdən (admin) sürücüyə mesaj. */
function notifySupportMessage(driverId, { messageId, adminName, text }) {
  return sendNotification(driverId, {
    title: adminName ? `Ofis • ${clip(adminName, 30)}` : 'Ofisdən mesaj',
    body: text,
    type: 'support_message',
    channel: 'chat',
    tag: 'support',
    data: { messageId },
  });
}

/** Sifariş ləğv olundu (sərnişin və ya admin tərəfindən). */
function notifyOrderCancelled(driverId, orderId, by) {
  const byAdmin = by === 'ADMIN';
  return sendNotification(driverId, {
    title: 'Sifariş ləğv olundu',
    body: byAdmin ? 'Administrator bu sifarişi ləğv etdi.' : 'Sərnişin sifarişi ləğv etdi.',
    type: 'order_cancelled',
    channel: 'trip',
    tag: `order_${orderId}`,
    data: { orderId },
  });
}

/** Cari səfər davam edərkən yeni sifariş növbəyə düşdü. */
function notifyQueuedOrder(driverId, orderId) {
  return sendNotification(driverId, {
    title: 'Növbəyə yeni sifariş əlavə olundu',
    body: 'Cari səfəri bitirdikdən sonra bu sifariş avtomatik aktivləşəcək.',
    type: 'queued_order',
    channel: 'trip',
    tag: `order_${orderId}`,
    data: { orderId },
  });
}

/** Administrator sifarişi bu sürücüyə təyin etdi. */
function notifyOrderAssigned(driverId, orderId) {
  return sendNotification(driverId, {
    title: 'Sizə sifariş təyin olundu',
    body: 'Administrator sifarişi sizə təyin etdi. Ətraflı məlumat üçün toxunun.',
    type: 'order_assigned',
    channel: 'trip',
    tag: `order_${orderId}`,
    data: { orderId },
  });
}

/** Administrator sifarişi sürücüdən başqasına keçirdi. */
function notifyOrderRemoved(driverId, orderId) {
  return sendNotification(driverId, {
    title: 'Sifariş sizdən alındı',
    body: 'Administrator bu sifarişi başqa sürücüyə keçirdi.',
    type: 'order_removed',
    channel: 'trip',
    tag: `order_${orderId}`,
    data: { orderId },
  });
}

/** Admin balansı artırdı / düzəliş etdi. */
function notifyBalanceChange(driverId, { amountMinor, balanceMinor, kind }) {
  const plus = Number(amountMinor) >= 0;
  return sendNotification(driverId, {
    title: kind === 'TOP_UP' ? 'Balans artırıldı' : plus ? 'Balansa əlavə olundu' : 'Balansdan çıxıldı',
    body: `${plus ? '+' : '−'}${azn(Math.abs(amountMinor))} · Cari balans: ${azn(balanceMinor)}`,
    type: 'wallet_update',
    channel: 'wallet',
    tag: 'wallet',
    data: { balanceMinor },
  });
}

/** Hesab statusu: təsdiqləndi / təsdiq götürüldü / bloklandı / aktivləşdirildi. */
function notifyAccount(driverId, kind) {
  const map = {
    verified: ['Hesabınız təsdiqləndi', 'Artıq onlayn olub sifariş qəbul edə bilərsiniz.'],
    unverified: ['Hesab təsdiqi götürüldü', 'Administrator hesabınızın təsdiqini götürdü. Əlavə məlumat üçün idarə ilə əlaqə saxlayın.'],
    blocked: ['Hesabınız deaktiv edildi', 'Administrator hesabınızı deaktiv etdi. Əlavə məlumat üçün idarə ilə əlaqə saxlayın.'],
    activated: ['Hesabınız aktivləşdirildi', 'Hesabınız yenidən aktivdir.'],
  };
  const t = map[kind];
  if (!t) return Promise.resolve(false);
  return sendNotification(driverId, {
    title: t[0],
    body: t[1],
    type: 'account_status',
    channel: 'account',
    tag: 'account',
    data: { kind },
  });
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
      // Müştərinin seçdiyi dayanacaqlar (sonuncusu təyinat): [{a: ünvan, la, ln}]
      stopsJson: JSON.stringify(
        (payload.stops || []).slice(0, 5).map((s) => ({
          a: String((s && (s.address || s.label)) || '').slice(0, 160),
          la: s && s.lat,
          ln: s && s.lng,
        }))
      ),
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

module.exports = {
  sendOffer,
  sendOfferEnded,
  sendToDriver,
  sendNotification,
  notifyChatMessage,
  notifySupportMessage,
  notifyOrderCancelled,
  notifyQueuedOrder,
  notifyOrderAssigned,
  notifyOrderRemoved,
  notifyBalanceChange,
  notifyAccount,
  CHANNEL,
  CLICK_ACTION,
};
