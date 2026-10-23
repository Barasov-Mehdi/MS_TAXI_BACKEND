/**
 * Sərnişinə push bildirişləri (tətbiq bağlı / arxa planda olanda).
 * Tətbiq açıqdırsa eyni hadisələri socket ilə alır və öz bildiriş zolağını göstərir; push isə
 * telefon kilidli olsa da gəlir. Hadisələr websocket/emitter.toCustomer-dən avtomatik ötürülür.
 *
 * Mətnlər müştərinin tətbiq dilində göndərilir (Customer.language: az | ru | en | tr; standart az).
 * Eyni sifariş + vəziyyət üçün qısa müddətdə bir dəfə göndərilir (bir neçə hadisə eyni anda gələ bilir).
 */
const DEDUP_MS = 60 * 1000;
const sent = new Map(); // `${orderId}:${key}` -> ms

const models = () => require('../models');
const push = () => require('./push.service');

const azn = (minor) => `${(Number(minor || 0) / 100).toFixed(2)} ₼`;

const LANGS = ['az', 'ru', 'en', 'tr'];

/** Bildiriş mətnləri. {name}, {car}, {price}, {message} əvəzlənir. */
const TEXTS = {
  az: {
    driver: 'Sürücü',
    assigned: ['Sürücü tapıldı', '{name} sizə doğru gəlir{carPart}'],
    queued: ['Sürücü tapıldı', 'Sürücü əvvəlki səfərini bitirən kimi sizə doğru gələcək'],
    arrivedCar: ['Sürücü çatdı', '{car} sizi gözləyir'],
    arrived: ['Sürücü çatdı', 'Sürücü sizi gözləyir'],
    started: ['Səfər başladı', 'Yaxşı yol! Səfəri tətbiqdə canlı izləyə bilərsiniz'],
    research: ['Yeni sürücü axtarılır', 'Sürücü sifarişdən imtina etdi. Sizə başqa sürücü axtarılır'],
    expired: ['Sürücü tapılmadı', 'Hazırda yaxınlıqda boş sürücü yoxdur. Bir az sonra yenidən cəhd edin'],
    completedPrice: ['Səfər tamamlandı', 'Ödəniləcək məbləğ: {price}. Sürücünü qiymətləndirin'],
    completed: ['Səfər tamamlandı', 'Sürücünü qiymətləndirin'],
    cancelledAdmin: ['Sifariş ləğv edildi', 'Sifariş ofis tərəfindən ləğv edildi'],
    cancelledDriver: ['Sifariş ləğv edildi', 'Sürücü sifarişi ləğv etdi'],
    stopped: ['Səfər dayandırıldı', 'Sürücü səfəri dayandırdı'],
  },
  ru: {
    driver: 'Водитель',
    assigned: ['Водитель найден', '{name} едет к вам{carPart}'],
    queued: ['Водитель найден', 'Водитель приедет к вам, как только завершит текущую поездку'],
    arrivedCar: ['Водитель прибыл', '{car} ждёт вас'],
    arrived: ['Водитель прибыл', 'Водитель ждёт вас'],
    started: ['Поездка началась', 'Хорошей дороги! Следите за поездкой в приложении'],
    research: ['Ищем нового водителя', 'Водитель отказался от заказа. Ищем вам другого водителя'],
    expired: ['Водитель не найден', 'Сейчас рядом нет свободных водителей. Попробуйте чуть позже'],
    completedPrice: ['Поездка завершена', 'К оплате: {price}. Оцените водителя'],
    completed: ['Поездка завершена', 'Оцените водителя'],
    cancelledAdmin: ['Заказ отменён', 'Заказ отменён офисом'],
    cancelledDriver: ['Заказ отменён', 'Водитель отменил заказ'],
    stopped: ['Поездка остановлена', 'Водитель остановил поездку'],
  },
  en: {
    driver: 'Driver',
    assigned: ['Driver found', '{name} is heading to you{carPart}'],
    queued: ['Driver found', 'Your driver will come to you after finishing the current ride'],
    arrivedCar: ['Driver arrived', '{car} is waiting for you'],
    arrived: ['Driver arrived', 'Your driver is waiting for you'],
    started: ['Trip started', 'Have a good ride! Track your trip live in the app'],
    research: ['Finding a new driver', 'The driver declined the ride. We are finding you another driver'],
    expired: ['No driver found', 'There are no available drivers nearby right now. Please try again shortly'],
    completedPrice: ['Ride completed', 'Amount due: {price}. Rate your driver'],
    completed: ['Ride completed', 'Rate your driver'],
    cancelledAdmin: ['Ride cancelled', 'The ride was cancelled by the office'],
    cancelledDriver: ['Ride cancelled', 'The driver cancelled the ride'],
    stopped: ['Trip stopped', 'The driver stopped the trip'],
  },
  tr: {
    driver: 'Sürücü',
    assigned: ['Sürücü bulundu', '{name} size doğru geliyor{carPart}'],
    queued: ['Sürücü bulundu', 'Sürücü önceki yolculuğunu bitirince size gelecek'],
    arrivedCar: ['Sürücü geldi', '{car} sizi bekliyor'],
    arrived: ['Sürücü geldi', 'Sürücü sizi bekliyor'],
    started: ['Yolculuk başladı', 'İyi yolculuklar! Yolculuğu uygulamada canlı takip edebilirsiniz'],
    research: ['Yeni sürücü aranıyor', 'Sürücü siparişi reddetti. Size başka bir sürücü aranıyor'],
    expired: ['Sürücü bulunamadı', 'Şu anda yakında boş sürücü yok. Lütfen biraz sonra tekrar deneyin'],
    completedPrice: ['Yolculuk tamamlandı', 'Ödenecek tutar: {price}. Sürücüyü değerlendirin'],
    completed: ['Yolculuk tamamlandı', 'Sürücüyü değerlendirin'],
    cancelledAdmin: ['Sipariş iptal edildi', 'Sipariş ofis tarafından iptal edildi'],
    cancelledDriver: ['Sipariş iptal edildi', 'Sürücü siparişi iptal etti'],
    stopped: ['Yolculuk durduruldu', 'Sürücü yolculuğu durdurdu'],
  },
};

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
}

function text(lang, key, vars = {}) {
  const dict = TEXTS[lang] || TEXTS.az;
  const [title, body] = dict[key] || TEXTS.az[key];
  return { title: fill(title, vars), body: fill(body, vars) };
}

function once(orderId, key) {
  const k = `${orderId}:${key}`;
  const now = Date.now();
  if (now - (sent.get(k) || 0) < DEDUP_MS) return false;
  sent.set(k, now);
  if (sent.size > 5000) {
    for (const [kk, t] of sent) if (now - t > DEDUP_MS) sent.delete(kk);
  }
  return true;
}

/** Müştərinin dili. Model / sənəd yoxdursa (köhnə qeydlər, testlər) Azərbaycan dili. */
async function languageOf(customerId) {
  try {
    const { Customer } = models();
    if (!Customer || !customerId) return 'az';
    const c = await Customer.findById(customerId).select('language').lean();
    return c && LANGS.includes(c.language) ? c.language : 'az';
  } catch (_) {
    return 'az';
  }
}

/** Sürücü və avtomobil haqqında qısa mətn: "Əli · Ağ Toyota Prius · 10-AB-123" */
async function driverLine(order, lang) {
  const fallback = (TEXTS[lang] || TEXTS.az).driver;
  if (!order || !order.driverId) return { name: fallback, car: '' };
  const { Driver, User, Vehicle } = models();
  const d = await Driver.findById(order.driverId).select('userId vehicleId').lean();
  if (!d) return { name: fallback, car: '' };
  const [u, v] = await Promise.all([
    User.findById(d.userId).select('firstName').lean(),
    d.vehicleId ? Vehicle.findById(d.vehicleId).select('make model color plateNumber').lean() : null,
  ]);
  const car = v ? [[v.color, v.make, v.model].filter(Boolean).join(' '), v.plateNumber].filter(Boolean).join(' · ') : '';
  return { name: (u && u.firstName) || fallback, car };
}

async function loadOrder(orderId) {
  const { Order } = models();
  return Order.findById(orderId).select('customerId driverId status pricingSnapshot.finalPriceMinor').lean();
}

async function build(event, payload, lang = 'az') {
  const orderId = payload && payload.orderId ? String(payload.orderId) : null;
  if (!orderId) return null;

  if (event === 'order_status_changed') {
    const st = payload.status;
    if (st === 'DRIVER_ASSIGNED') {
      if (!once(orderId, 'assigned')) return null;
      const { name, car } = await driverLine(await loadOrder(orderId), lang);
      return { ...text(lang, 'assigned', { name, carPart: car ? ` · ${car}` : '' }), type: 'driver_assigned' };
    }
    if (st === 'DRIVER_FINISHING_CURRENT_TRIP' || st === 'QUEUED') {
      if (!once(orderId, 'assigned')) return null;
      return { ...text(lang, 'queued'), type: 'driver_assigned' };
    }
    if (st === 'DRIVER_ARRIVED') {
      if (!once(orderId, 'arrived')) return null;
      const { car } = await driverLine(await loadOrder(orderId), lang);
      return { ...(car ? text(lang, 'arrivedCar', { car }) : text(lang, 'arrived')), type: 'driver_arrived' };
    }
    if (st === 'TRIP_STARTED') {
      if (!once(orderId, 'started')) return null;
      return { ...text(lang, 'started'), type: 'trip_started' };
    }
    if (st === 'SEARCHING_DRIVER' && (payload.reason === 'DRIVER_CANCELLED' || payload.reassigned)) {
      if (!once(orderId, `research:${Math.floor(Date.now() / 30000)}`)) return null;
      return { ...text(lang, 'research'), type: 'searching' };
    }
    if (st === 'EXPIRED') {
      if (!once(orderId, 'expired')) return null;
      return { ...text(lang, 'expired'), type: 'no_driver' };
    }
    return null;
  }

  if (event === 'trip_completed') {
    if (!once(orderId, 'completed')) return null;
    const o = await loadOrder(orderId);
    const price = o && o.pricingSnapshot ? o.pricingSnapshot.finalPriceMinor : null;
    return {
      ...(price != null ? text(lang, 'completedPrice', { price: azn(price) }) : text(lang, 'completed')),
      type: 'trip_completed',
    };
  }

  if (event === 'order_cancelled') {
    const o = await loadOrder(orderId);
    const st = (payload && payload.status) || (o && o.status);
    if (st === 'CUSTOMER_CANCELLED') return null; // müştəri özü ləğv edib
    if (!once(orderId, 'cancelled')) return null;
    return { ...text(lang, st === 'ADMIN_CANCELLED' ? 'cancelledAdmin' : 'cancelledDriver'), type: 'order_cancelled' };
  }

  if (event === 'trip_stopped') {
    if (!once(orderId, 'stopped')) return null;
    // Sürücünün yazdığı səbəb (payload.message) yalnız Azərbaycan dilində mövcuddur
    const t = text(lang, 'stopped');
    return { title: t.title, body: lang === 'az' && payload.message ? payload.message : t.body, type: 'trip_stopped' };
  }

  return null;
}

/** emitter.toCustomer-dən çağırılır. Heç vaxt xəta atmır. */
// Hər sərnişin üçün ardıcıllıq: "çatdı" bildirişi "səfər başladı"dan sonra gəlməsin
const chains = new Map();

function onCustomerEvent(customerId, event, payload) {
  if (!customerId) return;
  const key = String(customerId);
  const prev = chains.get(key) || Promise.resolve();
  const next = prev
    .then(async () => build(event, payload || {}, await languageOf(customerId)))
    .then((n) => {
      if (!n) return null;
      return push().sendToCustomer(customerId, {
        ...n,
        channel: 'trip',
        tag: `order_${payload.orderId}`,
        data: { orderId: String(payload.orderId) },
      });
    })
    .catch((e) => console.error('[customerNotify]', e && e.message));
  chains.set(key, next);
  next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
}

/** Sürücüdən sərnişinə çat mesajı. */
function chatMessage(customerId, { orderId, senderName, text: body }) {
  if (!customerId) return;
  push()
    .sendToCustomer(customerId, {
      title: senderName || 'Sürücü',
      body,
      type: 'chat_message',
      channel: 'chat',
      tag: `chat_${orderId}`,
      data: { orderId: String(orderId) },
    })
    .catch((e) => console.error('[customerNotify] chat', e && e.message));
}

function _reset() {
  sent.clear();
}

module.exports = { onCustomerEvent, chatMessage, build, languageOf, TEXTS, _reset };
