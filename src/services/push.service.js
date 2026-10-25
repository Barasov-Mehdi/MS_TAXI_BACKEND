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
const { Driver, Customer } = require('../models');

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

/**
 * İki tətbiq (sürücü: com.barasdrivers, sərnişin: com.barastaxi) FƏRQLİ Firebase layihələrindədirsə,
 * bir service account ilə hər ikisinə göndərmək olmur (FCM "SenderId mismatch" / mismatched-credential qaytarır).
 *   FIREBASE_DRIVER_SERVICE_ACCOUNT_B64   - sürücü tətbiqinin layihəsi (google-services.json: barasdrivers-f3fba)
 *   FIREBASE_CUSTOMER_SERVICE_ACCOUNT_B64 - sərnişin tətbiqinin layihəsi
 *   FIREBASE_SERVICE_ACCOUNT_B64          - ümumi (yuxarıdakılar yoxdursa hər ikisi üçün)
 */
const ENV = {
  driver: ['FIREBASE_DRIVER_SERVICE_ACCOUNT_B64', 'FIREBASE_DRIVER_SERVICE_ACCOUNT'],
  customer: ['FIREBASE_CUSTOMER_SERVICE_ACCOUNT_B64', 'FIREBASE_CUSTOMER_SERVICE_ACCOUNT'],
  shared: ['FIREBASE_SERVICE_ACCOUNT_B64', 'FIREBASE_SERVICE_ACCOUNT'],
};
const firstEnv = (names) => {
  for (const n of names) if (process.env[n]) return { name: n, raw: process.env[n] };
  return null;
};

/** Diaqnostika üçün vəziyyət (GET /admin/push/status). */
const state = {
  driver: { configured: false, envVar: null, projectId: null, initError: null, lastOkAt: null, lastError: null },
  customer: { configured: false, envVar: null, projectId: null, initError: null, lastOkAt: null, lastError: null },
};
const clients = {};
const tried = {};

function init(kind = 'driver') {
  if (tried[kind]) return clients[kind] || null;
  tried[kind] = true;
  const st = state[kind];
  try {
    const src = firstEnv(ENV[kind]) || firstEnv(ENV.shared);
    if (!src) {
      st.initError = 'Firebase service account təyin edilməyib (Heroku Config Vars)';
      console.warn(`[push] ${kind}: FIREBASE_*SERVICE_ACCOUNT* təyin edilməyib: push söndürülüb`);
      return null;
    }
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    const cred = parseServiceAccount(src.raw);
    // Hər layihə üçün ayrıca Firebase app (eyni layihədirsə eyni app paylaşılır)
    const name = `push_${cred.project_id}`;
    const existing = (admin.apps || []).find((a) => a && a.name === name);
    const app = existing || admin.initializeApp({ credential: admin.credential.cert(cred) }, name);
    clients[kind] = admin.messaging(app);
    Object.assign(st, { configured: true, envVar: src.name, projectId: cred.project_id, initError: null });
    console.log(`[push] ${kind}: Firebase hazırdır, layihə: ${cred.project_id} (${src.name})`);
  } catch (e) {
    st.initError = (e && e.message) || String(e);
    console.error(`[push] ${kind}: Firebase init alınmadı:`, st.initError);
    clients[kind] = null;
  }
  return clients[kind] || null;
}

const str = (v) => (v === undefined || v === null ? '' : String(v));

/** FCM xəta kodu → admin üçün izah. */
function explain(code) {
  const c = String(code || '');
  if (c.includes('mismatched-credential') || c.includes('sender-id-mismatch')) {
    return 'Service account başqa Firebase layihəsinə aiddir. Sürücü tətbiqinin layihəsi (google-services.json → project_id) ilə eyni olmalıdır: FIREBASE_DRIVER_SERVICE_ACCOUNT_B64 təyin edin.';
  }
  if (c.includes('registration-token-not-registered')) return 'Token köhnədir (tətbiq silinib/yenidən quraşdırılıb). Sürücü tətbiqi açmalıdır: yeni token avtomatik göndəriləcək.';
  if (c.includes('invalid-registration-token')) return 'Token yanlışdır. Sürücü tətbiqi yenidən açmalıdır.';
  if (c.includes('third-party-auth-error')) return 'Firebase layihəsində Cloud Messaging API (V1) aktiv deyil və ya açar etibarsızdır.';
  if (c.includes('invalid-credential') || c.includes('app/invalid-credential')) return 'Service account açarı etibarsızdır (silinib və ya JSON pozulub). Firebase Console-dan yeni açar yaradın.';
  if (c.includes('quota-exceeded')) return 'FCM limiti aşılıb, bir az sonra yenidən cəhd edin.';
  if (c.includes('unavailable') || c.includes('internal')) return 'FCM serveri müvəqqəti cavab vermir.';
  return '';
}

const isMismatch = (e) => {
  const c = String((e && e.code) || '') + ' ' + String((e && e.message) || '');
  return /mismatched-credential|sender-?id.?mismatch/i.test(c);
};

/**
 * Göndəriş + layihə ehtiyatı. Token BAŞQA Firebase layihəsinə aiddirsə (mismatched-credential), digər açar varsa
 * onunla bir dəfə təkrar cəhd edilir. Bu, tətbiqi bir layihədən digərinə köçürərkən lazımdır: köhnə versiyadakı
 * telefonların tokeni köhnə layihədən, yeni versiyadakılarınkı yeni layihədəndir — hər ikisinə çatır.
 */
async function sendVia(kind, m, message) {
  try {
    return await m.send(message);
  } catch (e) {
    if (!isMismatch(e)) throw e;
    const otherKind = kind === 'driver' ? 'customer' : 'driver';
    const other = init(otherKind);
    // Eyni layihənin açarıdırsa təkrar mənasızdır
    if (!other || other === m || state[otherKind].projectId === state[kind].projectId) throw e;
    return other.send(message);
  }
}

function noteResult(kind, err) {
  const st = state[kind];
  if (!err) {
    st.lastOkAt = new Date();
    return;
  }
  const code = err && err.code ? String(err.code) : '';
  st.lastError = { code, message: (err && err.message) || '', hint: explain(code), at: new Date() };
}

/**
 * FCM xətasında ölü tokeni təmizləyir.
 * DİQQƏT: "invalid-argument" token xətası DEYİL (payload xətası ola bilər) — əvvəl bu halda sağlam token silinirdi
 * və sürücüyə tətbiqi yenidən açana qədər heç bir bildiriş getmirdi.
 */
async function handleSendError(driverId, token, e) {
  const code = e && e.code ? String(e.code) : '';
  noteResult('driver', e);
  if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
    await Driver.updateOne({ _id: driverId, fcmToken: token }, { $set: { fcmToken: null } }).catch(() => {});
  } else {
    console.error('[push] göndərilmədi:', code || (e && e.message), explain(code));
  }
}

async function sendToDriver(driverId, data, { ttlMs = 30000 } = {}) {
  const m = init('driver');
  if (!m || !driverId) return false;
  const driver = await Driver.findById(driverId).select('+fcmToken').lean();
  if (!driver || !driver.fcmToken) return false;
  try {
    await sendVia('driver', m, {
      token: driver.fcmToken,
      data,
      android: {
        priority: 'high', // Doze rejimində də dərhal çatdırılsın
        ttl: Math.max(1000, ttlMs), // təklif bitəndən sonra köhnə push çatdırılmasın
        collapseKey: 'taxi_offer',
      },
    });
    noteResult('driver');
    return true;
  } catch (e) {
    await handleSendError(driverId, driver.fcmToken, e);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Bildirişlər (notification + data)
// ---------------------------------------------------------------------------------------------

/**
 * Sürücü tətbiqinin bildiriş kanalları — hər növün ÖZ SƏSİ var (res/raw/snd_*.ogg).
 * Id-lər sürücü tətbiqindəki android/.../notify/NotifySounds.kt ilə EYNİ olmalıdır.
 * `sound` — Android 7 və aşağı üçün (8+ səsi kanal təyin edir).
 */
const CHANNEL = {
  chat: 'd_chat',
  trip: 'd_trip',
  cancel: 'd_cancel',
  support: 'd_support',
  wallet: 'd_wallet',
  account: 'd_account',
  news: 'd_news',
  app: 'd_app',
};
const CHANNEL_SOUND = {
  d_chat: 'snd_chat',
  d_trip: 'snd_order',
  d_cancel: 'snd_cancel',
  d_support: 'snd_support',
  d_wallet: 'snd_wallet',
  d_account: 'snd_account',
  d_news: 'snd_news',
  d_app: 'snd_app',
};
/** Bildiriş növünə görə kanal (çağırışdakı `channel`-dan üstündür): ləğv və ofis mesajı ayrıca səslə gəlsin. */
const CHANNEL_BY_TYPE = {
  order_cancelled: 'cancel',
  order_removed: 'cancel',
  support_message: 'support',
  chat_message: 'chat',
  documents: 'account',
  account_status: 'account',
  wallet_update: 'wallet',
  news: 'news',
  app_update: 'app',
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
async function sendNotification(driverId, { title, body, type, channel = 'trip', data = {}, tag, ttlMs = 60 * 60 * 1000, imageUrl }) {
  const m = init('driver');
  if (!m || !driverId) return false;
  const driver = await Driver.findById(driverId).select('+fcmToken').lean();
  if (!driver || !driver.fcmToken) return false;

  const payload = { type: str(type) };
  for (const [k, v] of Object.entries(data)) payload[k] = str(v); // FCM data dəyərləri yalnız string ola bilər
  const channelId = CHANNEL[CHANNEL_BY_TYPE[type] || channel] || CHANNEL.trip;

  try {
    await sendVia('driver', m, {
      token: driver.fcmToken,
      // imageUrl → Android bildirişində böyük şəkil (BigPicture). Yalnız https ünvan qəbul olunur.
      notification: {
        title: clip(title, 80),
        body: clip(body, 180),
        ...(imageUrl && /^https:\/\//.test(imageUrl) ? { imageUrl } : {}),
      },
      data: payload,
      android: {
        priority: 'high',
        ttl: Math.max(1000, ttlMs),
        notification: {
          channelId,
          clickAction: CLICK_ACTION,
          sound: CHANNEL_SOUND[channelId] || 'default',
          defaultVibrateTimings: true,
          ...(tag ? { tag: String(tag).slice(0, 100) } : {}),
        },
      },
    });
    noteResult('driver');
    return true;
  } catch (e) {
    await handleSendError(driverId, driver.fcmToken, e);
    return false;
  }
}

/**
 * Sərnişin tətbiqinə bildiriş (MS Taxi). Kanallar müştəri tətbiqində (MainApplication.kt) yaradılır:
 * trip_updates, chat_messages. Toxunanda tətbiq açılır (data.type / orderId ilə).
 */
/**
 * Sərnişin tətbiqinin bildiriş görünüşü — hər növün öz KANALI (= öz səsi), ikonu və rəngi.
 * Kanallar və səslər sərnişin tətbiqində yaradılır: android/.../push/PushChannels.kt, res/raw/snd_*.ogg,
 * ikonlar res/drawable/ic_notif_*.xml. Köhnə tətbiq versiyasında kanal/ikon yoxdursa Android standartı (trip_updates) işlədir.
 *   sound: Android 7 və aşağı üçün (8+ səsi kanal təyin edir)
 */
const CUSTOMER_STYLE = {
  driver_assigned: { channelId: 'c_driver_found', sound: 'snd_driver_found', icon: 'ic_notif_car', color: '#00B14F' },
  driver_arrived: { channelId: 'c_driver_arrived', sound: 'snd_driver_arrived', icon: 'ic_notif_pin', color: '#00B14F' },
  trip_started: { channelId: 'c_trip', sound: 'snd_trip', icon: 'ic_notif_route', color: '#1D5FD1' },
  searching: { channelId: 'c_trip', sound: 'snd_trip', icon: 'ic_notif_search', color: '#B26A00' },
  trip_stopped: { channelId: 'c_trip', sound: 'snd_trip', icon: 'ic_notif_route', color: '#B26A00' },
  trip_completed: { channelId: 'c_trip_done', sound: 'snd_trip_done', icon: 'ic_notif_check', color: '#00B14F' },
  no_driver: { channelId: 'c_trip_cancelled', sound: 'snd_cancelled', icon: 'ic_notif_cancel', color: '#D93025' },
  order_cancelled: { channelId: 'c_trip_cancelled', sound: 'snd_cancelled', icon: 'ic_notif_cancel', color: '#D93025' },
  chat_message: { channelId: 'c_chat', sound: 'snd_message_in', icon: 'ic_notif_chat', color: '#00B14F' },
  support_message: { channelId: 'c_support', sound: 'snd_support', icon: 'ic_notif_support', color: '#6D3FD6' },
  test: { channelId: 'c_trip', sound: 'snd_trip', icon: 'ic_stat_notify', color: '#00B14F' },
};
const CUSTOMER_DEFAULT_STYLE = { channelId: 'c_trip', sound: 'snd_trip', icon: 'ic_stat_notify', color: '#00B14F' };

function customerAndroidNotification(type, tag) {
  const st = CUSTOMER_STYLE[type] || CUSTOMER_DEFAULT_STYLE;
  return {
    channelId: st.channelId,
    sound: st.sound,
    icon: st.icon,
    color: st.color,
    defaultVibrateTimings: true,
    ...(tag ? { tag: String(tag).slice(0, 100) } : {}),
  };
}

// `channel` köhnə çağırışlarla uyğunluq üçün qəbul olunur; görünüş `type`-a görə seçilir.
// eslint-disable-next-line no-unused-vars
async function sendToCustomer(customerId, { title, body, type, channel = 'trip', data = {}, tag, ttlMs = 30 * 60 * 1000 }) {
  const m = init('customer');
  if (!m || !customerId) return false;
  const customer = await Customer.findById(customerId).select('+fcmToken').lean();
  if (!customer || !customer.fcmToken) return false;
  const payload = { type: str(type) };
  for (const [k, v] of Object.entries(data)) payload[k] = str(v);
  try {
    await sendVia('customer', m, {
      token: customer.fcmToken,
      notification: { title: clip(title, 80), body: clip(body, 180) },
      data: payload,
      android: {
        priority: 'high',
        ttl: Math.max(1000, ttlMs),
        notification: customerAndroidNotification(type, tag),
      },
    });
    noteResult('customer');
    return true;
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    noteResult('customer', e);
    if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
      await Customer.updateOne({ _id: customerId, fcmToken: customer.fcmToken }, { $set: { fcmToken: null } }).catch(() => {});
    } else {
      console.error('[push] müştəriyə göndərilmədi:', code || (e && e.message));
    }
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

/** Sənəd yoxlanıldı (təsdiq / rədd). */
function notifyDocument(driverId, { label, approved, reason }) {
  return sendNotification(driverId, {
    title: approved ? 'Sənəd təsdiqləndi' : 'Sənəd rədd edildi',
    body: approved ? label : `${label}: ${reason || 'yenidən yükləyin'}`,
    type: 'documents',
    channel: 'account',
    tag: 'documents',
    data: {},
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
    blocked: ['Hesabınız bloklandı', 'Administrator hesabınızı bloklayıb. Ətraflı məlumat üçün ofislə əlaqə saxlayın.'],
    activated: ['Blok qaldırıldı', 'Hesabınız yenidən aktivdir. İndi onlayn olub sifariş qəbul edə bilərsiniz.'],
  };
  const t = map[kind];
  if (!t) return Promise.resolve(false);
  // Tətbiq açıqdırsa ekranda dərhal göstərilsin (push gecikə və ya söndürülə bilər)
  try {
    require('../websocket/emitter').toDriver(driverId, 'account_status', { kind, title: t[0], body: t[1] });
  } catch (_) { /* bildiriş əsas işi pozmasın */ }
  return sendNotification(driverId, {
    title: t[0],
    body: t[1],
    type: 'account_status',
    channel: 'account',
    tag: 'account',
    data: { kind },
  });
}

/** "Yeniliklər" bölməsinə yeni elan. Hamısı bir bildirişdə toplanır (tag), toxunanda Yeniliklər ekranı açılır. */
function notifyNews(driverId, news) {
  return sendNotification(driverId, {
    title: clip(news.title, 80) || 'Yenilik',
    body: news.body,
    type: 'news',
    channel: 'news',
    tag: 'news',
    data: { newsId: news.id },
    ttlMs: 24 * 60 * 60 * 1000,
    imageUrl: news.imageUrl || undefined,
  });
}

/** Play-də yeni versiya var. Toxunanda tətbiq açılır və yeniləmə pəncərəsi göstərilir. */
function notifyAppUpdate(driverId, info) {
  const name = info && info.latestVersionName ? ` ${info.latestVersionName}` : '';
  const notes = info && Array.isArray(info.notes) && info.notes.length ? info.notes.slice(0, 3).join(' • ') : '';
  return sendNotification(driverId, {
    title: `Yeni versiya${name} mövcuddur`,
    body: notes || 'Tətbiqi yeniləyin: yeni imkanlar və düzəlişlər.',
    type: 'app_update',
    channel: 'app',
    tag: 'app_update',
    data: { versionCode: info && info.latestVersionCode },
    ttlMs: 3 * 24 * 60 * 60 * 1000,
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

/** Admin üçün: Firebase konfiqurasiyası + son uğurlu/uğursuz göndəriş. */
function getStatus() {
  init('driver');
  init('customer');
  return JSON.parse(JSON.stringify(state));
}

/**
 * Sürücüyə test bildirişi + addım-addım diaqnoz. Hər addımda nə alınmadığı və necə düzəldiləcəyi qaytarılır.
 * delayMs: sürücü tətbiqi arxa plana keçirə bilsin deyə göndərişi gecikdirmək (tətbiqdən "Bildirişi yoxla").
 */
async function testDriver(driverId, { delayMs = 0 } = {}) {
  const out = { firebase: false, projectId: null, hasToken: false, tokenUpdatedAt: null, sent: false, errorCode: null, hint: '' };
  const m = init('driver');
  out.projectId = state.driver.projectId;
  if (!m) {
    out.hint = `${state.driver.initError || 'Firebase hazır deyil'}. Heroku → Settings → Config Vars: FIREBASE_DRIVER_SERVICE_ACCOUNT_B64 (və ya FIREBASE_SERVICE_ACCOUNT_B64) əlavə edin.`;
    return out;
  }
  out.firebase = true;
  const d = await Driver.findById(driverId).select('+fcmToken fcmTokenUpdatedAt').lean();
  if (!d || !d.fcmToken) {
    out.hint = 'Sürücünün cihaz tokeni serverdə yoxdur: tətbiqə yenidən daxil olsun, bildiriş icazəsini versin (Android 13+), internet olsun.';
    return out;
  }
  out.hasToken = true;
  out.tokenUpdatedAt = d.fcmTokenUpdatedAt || null;
  const send = () =>
    sendVia('driver', m, {
      token: d.fcmToken,
      notification: { title: 'Test bildirişi ✔', body: 'Bildirişlər işləyir. Bu mesajı görürsünüzsə, hər şey qaydasındadır.' },
      data: { type: 'test' },
      android: { priority: 'high', ttl: 120000, notification: { channelId: CHANNEL.trip, clickAction: CLICK_ACTION, sound: 'default', tag: 'push_test' } },
    });
  if (delayMs > 0) {
    // Tətbiqdən çağırılıb: cavab dərhal qayıdır, göndəriş bir neçə saniyə sonra (sürücü tətbiqi bağlaya bilsin)
    setTimeout(() => {
      send().then(() => noteResult('driver')).catch((e) => handleSendError(driverId, d.fcmToken, e));
    }, delayMs);
    out.sent = true;
    out.scheduled = true;
    return out;
  }
  try {
    await send();
    noteResult('driver');
    out.sent = true;
  } catch (e) {
    await handleSendError(driverId, d.fcmToken, e);
    out.errorCode = e && e.code ? String(e.code) : 'UNKNOWN';
    out.hint = explain(out.errorCode) || (e && e.message) || '';
  }
  return out;
}

/**
 * Sərnişinə test bildirişi + diaqnoz (admin → Ayarlar → Push bildirişləri → "Sərnişin").
 * Hansı layihənin açarı ilə çatdığını da qaytarır (layihə köçürmə dövründə faydalıdır).
 */
async function testCustomer(customerId) {
  const out = { firebase: false, projectId: null, hasToken: false, tokenUpdatedAt: null, sent: false, viaProjectId: null, errorCode: null, hint: '' };
  const m = init('customer');
  out.projectId = state.customer.projectId;
  if (!m) {
    out.hint = `${state.customer.initError || 'Firebase hazır deyil'}. Heroku Config Vars: FIREBASE_CUSTOMER_SERVICE_ACCOUNT_B64 (və ya FIREBASE_SERVICE_ACCOUNT_B64).`;
    return out;
  }
  out.firebase = true;
  const c = await Customer.findById(customerId).select('+fcmToken fcmTokenUpdatedAt').lean();
  if (!c || !c.fcmToken) {
    out.hint = 'Sərnişinin cihaz tokeni serverdə YOXDUR. Sərnişin tətbiqi tokeni POST /customers/fcm-token ilə göndərmir və ya bildiriş icazəsi verilməyib. Problem sərnişin tətbiqindədir.';
    return out;
  }
  out.hasToken = true;
  out.tokenUpdatedAt = c.fcmTokenUpdatedAt || null;
  const message = {
    token: c.fcmToken,
    notification: { title: 'Test bildirişi ✔', body: 'Baras: bildirişlər işləyir.' },
    data: { type: 'test' },
    android: { priority: 'high', ttl: 120000, notification: customerAndroidNotification('test', 'push_test') },
  };
  try {
    await m.send(message);
    out.sent = true;
    out.viaProjectId = state.customer.projectId;
    noteResult('customer');
  } catch (e) {
    // Başqa layihənin tokeni: sürücü açarı ilə yoxla (sərnişin tətbiqi o layihəyə köçürülübsə)
    if (isMismatch(e) && init('driver') && state.driver.projectId !== state.customer.projectId) {
      try {
        await init('driver').send(message);
        out.sent = true;
        out.viaProjectId = state.driver.projectId;
        out.hint = `Token ${state.driver.projectId} layihəsinə aiddir (ehtiyat açarla çatdı). Bütün sərnişinlər yeni versiyaya keçəndə FIREBASE_CUSTOMER_SERVICE_ACCOUNT_B64 = ${state.driver.projectId} açarı edin.`;
        return out;
      } catch (e2) {
        e = e2; // eslint-disable-line no-ex-assign
      }
    }
    noteResult('customer', e);
    out.errorCode = e && e.code ? String(e.code) : 'UNKNOWN';
    out.hint = explain(out.errorCode) || (e && e.message) || '';
    if (/not-registered|invalid-registration/.test(out.errorCode)) {
      await Customer.updateOne({ _id: customerId, fcmToken: c.fcmToken }, { $set: { fcmToken: null } }).catch(() => {});
    }
  }
  return out;
}

module.exports = {
  getStatus,
  testDriver,
  testCustomer,
  explain,
  sendOffer,
  sendOfferEnded,
  sendToDriver,
  sendNotification,
  notifyChatMessage,
  notifySupportMessage,
  notifyDocument,
  notifyOrderCancelled,
  notifyQueuedOrder,
  notifyOrderAssigned,
  notifyOrderRemoved,
  notifyBalanceChange,
  notifyAccount,
  notifyNews,
  notifyAppUpdate,
  sendToCustomer,
  CUSTOMER_STYLE,
  CHANNEL,
  CLICK_ACTION,
};
