/**
 * Admin panel üçün canlı axın.
 *
 * Panel bu hadisələri alır (baş admin hamısını, regional admin yalnız öz şəhərininkini):
 *   admin_order            { order }            — sifariş yarandı / statusu dəyişdi
 *   admin_driver           { driver, reason }   — onlayn/oflayn, balans, blok, təsdiq, məlumat dəyişdi
 *   admin_driver_location  { driverId, ... }    — canlı xəritə üçün konum (sürücü başına ~3 san-dən bir)
 *   admin_feedback         { orderId, ... }     — müştəri qiymət/rəy yazdı
 *   admin_issue            { issue }            — səfər problemi bildirildi
 *
 * Eyni obyekt üçün qısa müddətdə gələn bir neçə dəyişiklik birləşdirilir (bir DB sorğusu, bir hadisə).
 * Bütün funksiyalar "fire-and-forget"-dir: xəta əsas əməliyyatı heç vaxt pozmur.
 */
const DEBOUNCE_MS = 250;
const LOCATION_EVERY_MS = 3000;

const pendingOrders = new Map(); // orderId -> timer
const pendingDrivers = new Map(); // driverId -> { timer, reason }
const lastLocationAt = new Map(); // driverId -> ms

const emitter = () => require('./emitter');
const models = () => require('../models');

// Taymer prosesi açıq saxlamasın (testlər, səliqəli bağlanma)
function later(fn) {
  const t = setTimeout(fn, DEBOUNCE_MS);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

const idOf = (x) => (x && x._id ? String(x._id) : x ? String(x) : null);
const quiet = (p) => Promise.resolve(p).catch((e) => console.error('[adminFeed]', e && e.message ? e.message : e));

async function pushOrder(orderId) {
  const { Order } = models();
  const o = await Order.findById(orderId)
    .select('status cityId driverId customerId pickupAddress pickupLabel distanceMeters vehicleType paymentMethod pricingSnapshot.finalPriceMinor currentOfferDriverId createdAt updatedAt')
    .lean();
  if (!o) return;
  emitter().toAdminCity(o.cityId || null, 'admin_order', {
    order: {
      _id: o._id,
      status: o.status,
      cityId: o.cityId || null,
      driverId: o.driverId || null,
      customerId: o.customerId,
      pickupAddress: o.pickupAddress || o.pickupLabel || '',
      distanceMeters: o.distanceMeters,
      vehicleType: o.vehicleType,
      paymentMethod: o.paymentMethod,
      priceMinor: o.pricingSnapshot ? o.pricingSnapshot.finalPriceMinor : null,
      offeredTo: o.currentOfferDriverId || null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    },
  });
}

async function pushDriver(driverId, reason) {
  const { Driver, User } = models();
  const d = await Driver.findById(driverId)
    .select('userId cityId isOnline isActive isVerified walletBalanceMinor currentOrderId ratingAvg deletedAt onlineSince')
    .lean();
  if (!d) return;
  const u = await User.findById(d.userId).select('firstName lastName phone').lean();
  emitter().toAdminCity(d.cityId || null, 'admin_driver', {
    reason: reason || 'updated',
    driver: {
      _id: d._id,
      name: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '',
      phone: u ? u.phone : '',
      cityId: d.cityId || null,
      isOnline: !!d.isOnline,
      isActive: d.isActive !== false,
      isVerified: !!d.isVerified,
      busy: !!d.currentOrderId,
      currentOrderId: d.currentOrderId || null,
      walletBalanceMinor: d.walletBalanceMinor || 0,
      ratingAvg: d.ratingAvg,
      deleted: !!d.deletedAt,
      onlineSince: d.onlineSince || null,
    },
  });
}

/** Sifariş yarandı və ya dəyişdi. */
function orderChanged(order) {
  const id = idOf(order);
  if (!id) return;
  clearTimeout(pendingOrders.get(id));
  pendingOrders.set(
    id,
    later(() => {
      pendingOrders.delete(id);
      quiet(pushOrder(id));
    })
  );
}

/** Sürücünün vəziyyəti dəyişdi (reason: online | offline | balance | blocked | verified | profile | order ...). */
function driverChanged(driver, reason) {
  const id = idOf(driver);
  if (!id) return;
  const prev = pendingDrivers.get(id);
  if (prev) clearTimeout(prev.timer);
  const r = reason || (prev && prev.reason) || 'updated';
  pendingDrivers.set(id, {
    reason: r,
    timer: later(() => {
      pendingDrivers.delete(id);
      quiet(pushDriver(id, r));
    }),
  });
}

/** Canlı xəritə: konum (sürücü başına seyrəldilmiş). */
function driverLocation(driver) {
  if (!driver || !driver.location || !Array.isArray(driver.location.coordinates)) return;
  const id = String(driver._id);
  const now = Date.now();
  if (now - (lastLocationAt.get(id) || 0) < LOCATION_EVERY_MS) return;
  lastLocationAt.set(id, now);
  const [lng, lat] = driver.location.coordinates;
  if (!lat && !lng) return;
  try {
    emitter().toAdminCity(driver.cityId || null, 'admin_driver_location', {
      driverId: id,
      lat,
      lng,
      heading: driver.locationMeta ? driver.locationMeta.heading : null,
      speed: driver.locationMeta ? driver.locationMeta.speed : null,
      isOnline: !!driver.isOnline,
      busy: !!driver.currentOrderId,
      at: new Date(now).toISOString(),
    });
  } catch (e) {
    console.error('[adminFeed] location', e && e.message);
  }
}

/** Müştəri rəyi / qiyməti və ya şikayəti. */
function feedback({ order, score, comment, complaint }) {
  if (!order) return;
  quiet(
    (async () => {
      emitter().toAdminCity(order.cityId || null, 'admin_feedback', {
        orderId: order._id,
        driverId: order.driverId || null,
        score: score == null ? null : score,
        comment: comment || '',
        complaint: complaint || null,
      });
    })()
  );
  orderChanged(order);
  if (order.driverId) driverChanged(order.driverId, 'rating');
}

/** Səfər problemi (sürücü və ya müştəri bildirdi). */
function issue(doc) {
  if (!doc) return;
  quiet(
    (async () => {
      const { Order } = models();
      const o = await Order.findById(doc.orderId).select('cityId').lean();
      emitter().toAdminCity(o ? o.cityId : null, 'admin_issue', {
        issue: { _id: doc._id, orderId: doc.orderId, type: doc.type, reporterRole: doc.reporterRole, createdAt: doc.createdAt },
      });
    })()
  );
}

/** Testlər üçün: gözləyən taymerləri təmizlə. */
function _reset() {
  pendingOrders.forEach((t) => clearTimeout(t));
  pendingDrivers.forEach((p) => clearTimeout(p.timer));
  pendingOrders.clear();
  pendingDrivers.clear();
  lastLocationAt.clear();
}

module.exports = { orderChanged, driverChanged, driverLocation, feedback, issue, _reset };
