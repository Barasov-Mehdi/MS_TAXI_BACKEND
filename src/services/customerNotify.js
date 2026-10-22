/**
 * Sərnişinə push bildirişləri (tətbiq bağlı / arxa planda olanda).
 * Tətbiq açıqdırsa eyni hadisələri socket ilə alır və öz bildiriş zolağını göstərir; push isə
 * telefon kilidli olsa da gəlir. Hadisələr websocket/emitter.toCustomer-dən avtomatik ötürülür.
 *
 * Eyni sifariş + vəziyyət üçün qısa müddətdə bir dəfə göndərilir (bir neçə hadisə eyni anda gələ bilir).
 */
const DEDUP_MS = 60 * 1000;
const sent = new Map(); // `${orderId}:${key}` -> ms

const models = () => require('../models');
const push = () => require('./push.service');

const azn = (minor) => `${(Number(minor || 0) / 100).toFixed(2)} ₼`;

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

/** Sürücü və avtomobil haqqında qısa mətn: "Əli · Ağ Toyota Prius · 10-AB-123" */
async function driverLine(order) {
  if (!order || !order.driverId) return { name: 'Sürücü', car: '' };
  const { Driver, User, Vehicle } = models();
  const d = await Driver.findById(order.driverId).select('userId vehicleId').lean();
  if (!d) return { name: 'Sürücü', car: '' };
  const [u, v] = await Promise.all([
    User.findById(d.userId).select('firstName').lean(),
    d.vehicleId ? Vehicle.findById(d.vehicleId).select('make model color plateNumber').lean() : null,
  ]);
  const car = v ? [[v.color, v.make, v.model].filter(Boolean).join(' '), v.plateNumber].filter(Boolean).join(' · ') : '';
  return { name: (u && u.firstName) || 'Sürücü', car };
}

async function loadOrder(orderId) {
  const { Order } = models();
  return Order.findById(orderId).select('customerId driverId status pricingSnapshot.finalPriceMinor').lean();
}

async function build(event, payload) {
  const orderId = payload && payload.orderId ? String(payload.orderId) : null;
  if (!orderId) return null;

  if (event === 'order_status_changed') {
    const st = payload.status;
    if (st === 'DRIVER_ASSIGNED') {
      if (!once(orderId, 'assigned')) return null;
      const { name, car } = await driverLine(await loadOrder(orderId));
      return { title: 'Sürücü tapıldı', body: `${name} sizə doğru gəlir${car ? ` · ${car}` : ''}`, type: 'driver_assigned' };
    }
    if (st === 'DRIVER_FINISHING_CURRENT_TRIP' || st === 'QUEUED') {
      if (!once(orderId, 'assigned')) return null;
      return { title: 'Sürücü tapıldı', body: 'Sürücü əvvəlki səfərini bitirən kimi sizə doğru gələcək', type: 'driver_assigned' };
    }
    if (st === 'DRIVER_ARRIVED') {
      if (!once(orderId, 'arrived')) return null;
      const { car } = await driverLine(await loadOrder(orderId));
      return { title: 'Sürücü çatdı', body: car ? `${car} sizi gözləyir` : 'Sürücü sizi gözləyir', type: 'driver_arrived' };
    }
    if (st === 'TRIP_STARTED') {
      if (!once(orderId, 'started')) return null;
      return { title: 'Səfər başladı', body: 'Yaxşı yol! Səfəri tətbiqdə canlı izləyə bilərsiniz', type: 'trip_started' };
    }
    if (st === 'SEARCHING_DRIVER' && (payload.reason === 'DRIVER_CANCELLED' || payload.reassigned)) {
      if (!once(orderId, `research:${Math.floor(Date.now() / 30000)}`)) return null;
      return { title: 'Yeni sürücü axtarılır', body: 'Sürücü sifarişdən imtina etdi. Sizə başqa sürücü axtarılır', type: 'searching' };
    }
    if (st === 'EXPIRED') {
      if (!once(orderId, 'expired')) return null;
      return { title: 'Sürücü tapılmadı', body: 'Hazırda yaxınlıqda boş sürücü yoxdur. Bir az sonra yenidən cəhd edin', type: 'no_driver' };
    }
    return null;
  }

  if (event === 'trip_completed') {
    if (!once(orderId, 'completed')) return null;
    const o = await loadOrder(orderId);
    const price = o && o.pricingSnapshot ? o.pricingSnapshot.finalPriceMinor : null;
    return {
      title: 'Səfər tamamlandı',
      body: price != null ? `Ödəniləcək məbləğ: ${azn(price)}. Sürücünü qiymətləndirin` : 'Sürücünü qiymətləndirin',
      type: 'trip_completed',
    };
  }

  if (event === 'order_cancelled') {
    const o = await loadOrder(orderId);
    const st = (payload && payload.status) || (o && o.status);
    if (st === 'CUSTOMER_CANCELLED') return null; // müştəri özü ləğv edib
    if (!once(orderId, 'cancelled')) return null;
    return {
      title: 'Sifariş ləğv edildi',
      body: st === 'ADMIN_CANCELLED' ? 'Sifariş ofis tərəfindən ləğv edildi' : 'Sürücü sifarişi ləğv etdi',
      type: 'order_cancelled',
    };
  }

  if (event === 'trip_stopped') {
    if (!once(orderId, 'stopped')) return null;
    return { title: 'Səfər dayandırıldı', body: payload.message || 'Sürücü səfəri dayandırdı', type: 'trip_stopped' };
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
    .then(() => build(event, payload || {}))
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
function chatMessage(customerId, { orderId, senderName, text }) {
  if (!customerId) return;
  push()
    .sendToCustomer(customerId, {
      title: senderName || 'Sürücü',
      body: text,
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

module.exports = { onCustomerEvent, chatMessage, build, _reset };
