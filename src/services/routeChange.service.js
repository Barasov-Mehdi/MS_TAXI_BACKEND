/**
 * Sifariş zamanı marşrutun dəyişməsi (Bolt kimi).
 *
 * Müştəri təyinatı dəyişə və ya dayanacaq əlavə edə bilər:
 *  - Səfər başlamazdan əvvəl (sürücü yoldadır / çatıb): qiymət götürmə yerindən yeni ünvanlara YENİDƏN hesablanır.
 *  - Səfər zamanı: qiymət = artıq GEDİLƏN yol (GPS odometri) + sürücünün indiki yerindən yeni ünvanlara qalan yol,
 *    vaxt = keçən dəqiqələr + qalan dəqiqələr. Hamısı adi tariflə (km zolaqları, dəqiqə, dayanacaq haqqı) hesablanır.
 *  - Promo kod yenidən tətbiq olunur, gözləmə haqqı və köhnə ləğv haqqı (varsa) saxlanılır.
 *
 * Axın: POST .../route/quote (qiymət göstərilir) → müştəri təsdiq edir → POST .../route { expectedPriceMinor }.
 * Arada qiymət dəyişibsə (sürücü irəlilədi, tarif dəyişdi) 409 PRICE_CHANGED + yeni təklif qaytarılır.
 * Sürücüyə: socket `order_route_changed` + push bildirişi.
 */
const { Order, Driver, PromoCode } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const { AppError } = require('../utils/errors');
const { point } = require('../utils/geo');
const pricingService = require('./pricing.service');
const promoService = require('./promo.service');
const { getSettings } = require('./settings.service');
const realtime = require('../websocket/emitter');
const adminFeed = require('../websocket/adminFeed');

const MAX_STOPS = 4;
const BEFORE_TRIP = new Set([
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.DRIVER_ON_THE_WAY,
  OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
  OrderStatus.DRIVER_ARRIVED,
  OrderStatus.QUEUED,
  OrderStatus.DRIVER_FINISHING_CURRENT_TRIP,
]);
const CHANGEABLE = new Set([...BEFORE_TRIP, OrderStatus.TRIP_STARTED]);

function cleanStops(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new AppError('INVALID_POINTS', 'Ən azı bir ünvan seçin', 400);
  if (raw.length > MAX_STOPS) throw new AppError('TOO_MANY_STOPS', `Ən çox ${MAX_STOPS} ünvan ola bilər`, 400);
  return raw.map((p) => {
    const lat = Number(p && p.lat);
    const lng = Number(p && p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new AppError('INVALID_POINTS', 'Ünvanın koordinatı düzgün deyil', 400);
    }
    return {
      lat,
      lng,
      label: p.label ? String(p.label).slice(0, 200) : '',
      address: p.address ? String(p.address).slice(0, 300) : '',
    };
  });
}

/** Gedilən yol (metr): GPS odometri; yoxdursa götürmə yerindən indiki yerə düz xətt × 1.3. */
function traveledMeters(order, here) {
  const gps = Number(order.tripMeters) || 0;
  if (gps >= 50) return Math.round(gps);
  if (!here || !order.pickup || !order.pickup.coordinates) return 0;
  const { haversineMeters } = require('../utils/geo');
  const [plng, plat] = order.pickup.coordinates;
  return Math.round(haversineMeters(plat, plng, here.lat, here.lng) * 1.3);
}

async function driverPosition(order) {
  if (!order.driverId) return null;
  const d = await Driver.findById(order.driverId).select('location').lean();
  const c = d && d.location && d.location.coordinates;
  if (!c || (c[0] === 0 && c[1] === 0)) return null;
  return { lat: c[1], lng: c[0] };
}

async function promoDiscount(order, priceMinor) {
  if (!order.promoCode) return 0;
  try {
    const promo = await PromoCode.findOne({ code: String(order.promoCode).toUpperCase() }).lean();
    if (!promo) return Math.min((order.pricingSnapshot && order.pricingSnapshot.discountMinor) || 0, priceMinor);
    return promoService.computeDiscount(promo, priceMinor);
  } catch (_) {
    return 0;
  }
}

/**
 * Yeni marşrutun qiyməti (bazaya heç nə yazmır).
 * @param {{order, stops, distanceMeters?, durationMin?}} p  distanceMeters/durationMin: tətbiqin Mapbox marşrutu
 *   (səfər başlamayıbsa götürmə yerindən, başlayıbsa sürücünün indiki yerindən yeni ünvanlara)
 */
async function computeRouteChange({ order, stops: rawStops, distanceMeters, durationMin }) {
  if (!CHANGEABLE.has(order.status)) {
    throw new AppError('ROUTE_CHANGE_NOT_ALLOWED', 'Bu mərhələdə marşrutu dəyişmək olmur', 409);
  }
  if (order.paymentMethod && order.paymentMethod !== 'CASH') {
    throw new AppError('ROUTE_CHANGE_NOT_ALLOWED', 'Bu ödəniş üsulunda marşrut dəyişmir', 409);
  }
  const settings = await getSettings();
  const maxChanges = Number(settings.maxRouteChanges ?? 10);
  if ((order.routeChanges || []).length >= maxChanges) {
    throw new AppError('ROUTE_CHANGE_LIMIT', `Marşrutu ən çox ${maxChanges} dəfə dəyişmək olar`, 409);
  }
  const stops = cleanStops(rawStops);
  const vehicleType = pricingService.normalizeVehicleType(order.vehicleType || 'basic');
  const snap = order.pricingSnapshot || {};
  const [plng, plat] = order.pickup.coordinates;
  const pickup = { lat: plat, lng: plng };

  let traveled = 0;
  let elapsedMin = 0;
  let remaining;
  let from = pickup;
  if (order.status === OrderStatus.TRIP_STARTED) {
    from = (await driverPosition(order)) || pickup;
    traveled = traveledMeters(order, from);
    elapsedMin = order.startedAt ? Math.max(0, (Date.now() - new Date(order.startedAt).getTime()) / 60000) : 0;
  }
  remaining = await pricingService.resolveTripMetricsAsync({ points: [from, ...stops], distanceMeters, durationMin });

  const totalMeters = Math.round(traveled + remaining.distanceMeters);
  const totalMin = Math.round((elapsedMin + remaining.durationMin) * 10) / 10;
  const input = { distanceMeters: totalMeters, durationMin: totalMin, stopCount: stops.length - 1, vehicleType };
  const raw = await pricingService.calculateTripPrice({ ...input, promoDiscountMinor: 0 });
  const discountMinor = await promoDiscount(order, raw.finalPriceMinor);
  const priced = await pricingService.calculateTripPrice({ ...input, promoDiscountMinor: discountMinor });

  const waiting = snap.waitingFareMinor || 0;
  const debt = snap.cancellationDebtMinor || 0;
  const finalPriceMinor = priced.finalPriceMinor + waiting + debt;
  return {
    stops,
    previousPriceMinor: snap.finalPriceMinor || 0,
    finalPriceMinor,
    distanceMeters: totalMeters,
    durationMin: totalMin,
    traveledMeters: traveled,
    remainingMeters: remaining.distanceMeters,
    remainingMin: remaining.durationMin,
    inTrip: order.status === OrderStatus.TRIP_STARTED,
    snapshot: {
      ...priced,
      waitingFareMinor: waiting,
      cancellationDebtMinor: debt,
      finalPriceMinor,
      initialFinalPriceMinor: snap.initialFinalPriceMinor || snap.finalPriceMinor || finalPriceMinor,
      cancellationFeeMinor: priced.cancellationFeeMinor,
    },
  };
}

const publicQuote = (q) => ({
  previousPriceMinor: q.previousPriceMinor,
  priceMinor: q.finalPriceMinor,
  price: q.finalPriceMinor / 100,
  differenceMinor: q.finalPriceMinor - q.previousPriceMinor,
  distanceMeters: q.distanceMeters,
  durationMin: q.durationMin,
  traveledMeters: q.traveledMeters,
  remainingMeters: q.remainingMeters,
  remainingMin: q.remainingMin,
  inTrip: q.inTrip,
  currency: 'AZN',
});

async function quoteRouteChange(args) {
  return publicQuote(await computeRouteChange(args));
}

/** Qiymət fərqi bu həddən böyükdürsə müştəri yenidən təsdiq etməlidir (sürücü irəlilədikcə qiymət az dəyişir). */
const PRICE_TOLERANCE_MINOR = 50;

async function applyRouteChange({ order, stops, distanceMeters, durationMin, expectedPriceMinor, actorUserId }) {
  const q = await computeRouteChange({ order, stops, distanceMeters, durationMin });
  const expected = Number(expectedPriceMinor);
  if (Number.isFinite(expected) && Math.abs(expected - q.finalPriceMinor) > Math.max(PRICE_TOLERANCE_MINOR, expected * 0.03)) {
    throw new AppError('PRICE_CHANGED', 'Qiymət yeniləndi, yenidən təsdiq edin', 409, { quote: publicQuote(q) });
  }
  const last = q.stops[q.stops.length - 1];
  const change = {
    at: new Date(),
    status: order.status,
    fromPriceMinor: q.previousPriceMinor,
    toPriceMinor: q.finalPriceMinor,
    traveledMeters: q.traveledMeters,
    distanceMeters: q.distanceMeters,
    stopCount: q.stops.length,
  };
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status, version: order.version },
    {
      $set: {
        stops: q.stops,
        destination: point(last.lng, last.lat),
        distanceMeters: q.distanceMeters,
        durationMin: q.durationMin,
        pricingSnapshot: { ...(((typeof order.toObject === 'function' ? order.toObject() : order).pricingSnapshot) || {}), ...q.snapshot },
      },
      $push: { routeChanges: change },
      $inc: { version: 1 },
    },
    { new: true }
  );
  if (!updated) throw new AppError('ORDER_STATE_CHANGED', 'Sifarişin vəziyyəti dəyişdi, yenidən cəhd edin', 409);

  const payload = {
    orderId: updated._id,
    status: updated.status,
    stops: updated.stops,
    finalPriceMinor: q.finalPriceMinor,
    previousPriceMinor: q.previousPriceMinor,
    distanceMeters: q.distanceMeters,
    durationMin: q.durationMin,
  };
  if (updated.driverId) {
    realtime.toDriver(updated.driverId, 'order_route_changed', payload);
    // Köhnə sürücü tətbiqləri bu hadisəni tanımır: status hadisəsi ilə sifarişi yenidən yükləyirlər
    realtime.toDriver(updated.driverId, 'order_status_changed', { orderId: updated._id, status: updated.status, routeChanged: true });
    const push = require('./push.service');
    push.sendNotification(updated.driverId, {
      title: 'Sərnişin marşrutu dəyişdi',
      body: `Yeni ünvan: ${(last.label || last.address || '').slice(0, 80)} · Qiymət: ${(q.finalPriceMinor / 100).toFixed(2)} ₼`,
      type: 'order_route_changed',
      channel: 'trip',
      tag: `order_${updated._id}`,
      data: { orderId: updated._id },
    }).catch(() => {});
  }
  realtime.toOrder(updated._id, 'order_route_changed', payload);
  realtime.toCustomer(updated.customerId, 'order_route_changed', payload);
  adminFeed.orderChanged(updated._id);
  void actorUserId;
  return { order: updated, quote: publicQuote(q) };
}

module.exports = { computeRouteChange, quoteRouteChange, applyRouteChange, CHANGEABLE, MAX_STOPS, cleanStops, traveledMeters };
