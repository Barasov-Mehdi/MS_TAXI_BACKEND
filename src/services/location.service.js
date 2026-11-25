const crypto = require('crypto');
const { Driver, Customer } = require('../models');
const { getSettings } = require('./settings.service');
const { point, haversineMeters } = require('../utils/geo');
const realtime = require('../websocket/emitter');
const adminFeed = require('../websocket/adminFeed');
const { Order } = require('../models');
const matchingService = require('./matching.service');

const { AppError } = require('../utils/errors');

/** Koordinatları yoxlayır: NaN/aralıqdan kənar dəyər 2dsphere indeksini korlayır və sorğunu çökdürür. */
function parseCoordinates(payload) {
  const latitude = Number(payload && payload.latitude);
  const longitude = Number(payload && payload.longitude);
  if (
    payload == null ||
    payload.latitude == null ||
    payload.longitude == null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new AppError('INVALID_LOCATION', 'Invalid coordinates', 400);
  }
  return { latitude, longitude };
}

const MAX_FIX_AGE_MS = 60 * 60 * 1000;
const finiteOrNull = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

async function updateDriverLocation(driver, payload) {
  if (!driver) throw new AppError('PROFILE_NOT_FOUND', 'Driver profile not found', 403);
  const { latitude, longitude } = parseCoordinates(payload);
  const accuracy = finiteOrNull(payload.accuracy);
  const heading = finiteOrNull(payload.heading);
  const speed = finiteOrNull(payload.speed);
  let ts = payload.timestamp ? new Date(payload.timestamp) : new Date();
  if (Number.isNaN(ts.getTime())) ts = new Date();
  // Gələcəkdən gələn timestamp sonrakı bütün yeniləmələri "köhnə" saydırmasın.
  if (ts.getTime() > Date.now() + 60_000) ts = new Date();

  // Koordinatın yaşı: cihaz özü hesablayıb göndərir (fixAgeMs = göndərmə anı - GPS ölçmə anı), beləliklə
  // telefonun saatı serverdən fərqli olsa belə düzgün qalır. Köhnə tətbiq versiyası göndərmirsə, koordinat təzə sayılır.
  const fixAgeRaw = finiteOrNull(payload.fixAgeMs);
  const fixAgeMs = fixAgeRaw == null ? 0 : Math.min(Math.max(fixAgeRaw, 0), MAX_FIX_AGE_MS);

  // Köhnə / çox qeyri-dəqiq mövqe koordinatı dəyişmir, amma sürücünün "canlı" olduğunu göstərir:
  // əks halda sürücü tətbiq açıq olduğu halda 45 san sonra offline edilirdi.
  const touchAlive = async () => {
    const t = new Date();
    await Driver.updateOne({ _id: driver._id }, { $set: { locationUpdatedAt: t } });
    driver.locationUpdatedAt = t;
    return driver;
  };
  // Eyni (və ya daha köhnə) GPS ölçməsinin təkrarı (heartbeat) koordinatı və "təzəlik" vaxtını dəyişmir, yalnız canlılığı göstərir.
  if (driver.locationMeta && driver.locationMeta.timestamp && ts <= driver.locationMeta.timestamp) {
    return touchAlive();
  }
  const settings = await getSettings();
  if (accuracy != null && accuracy > (settings.maxLocationAccuracyMeters || 80) * 3) {
    return touchAlive();
  }
  const now = new Date();
  const fixAt = new Date(now.getTime() - fixAgeMs);
  const prevCoords = driver.location && driver.location.coordinates;
  // Atomik yeniləmə: tam sənədi save() etmirik ki, paralel dəyişikliklər (currentOrderId, isOnline) üstünə yazılmasın.
  await Driver.updateOne(
    { _id: driver._id },
    {
      $set: {
        location: point(longitude, latitude),
        locationMeta: { accuracy, heading, speed, timestamp: ts },
        locationUpdatedAt: now,
        locationFixAt: fixAt,
      },
    }
  );
  driver.location = point(longitude, latitude);
  driver.locationMeta = { accuracy, heading, speed, timestamp: ts };
  driver.locationUpdatedAt = now;
  driver.locationFixAt = fixAt;
  adminFeed.driverLocation(driver); // admin panelin canlı xəritəsi

  if (driver.currentOrderId) {
    // Yalnız lazım olan sahələr (hər GPS yeniləməsində tam sənəd oxunmasın)
    const order = await Order.findById(driver.currentOrderId).select('customerId status').lean();
    // Faktiki yol (odometr): yalnız səfər zamanı, dəqiq GPS ilə və real hərəkətdə (sıçrayışlar atılır)
    if (order && order.status === 'TRIP_STARTED' && prevCoords && !(prevCoords[0] === 0 && prevCoords[1] === 0)) {
      const step = haversineMeters(prevCoords[1], prevCoords[0], latitude, longitude);
      if (step >= 5 && step <= 2000 && (accuracy == null || accuracy <= 50)) {
        await Order.updateOne({ _id: order._id, status: 'TRIP_STARTED' }, { $inc: { tripMeters: Math.round(step) } });
      }
    }
    if (order) {
      // Bir emit: sərnişinin şəxsi otağı + sifariş otağı (eyni soketə hadisə bir dəfə çatır, trafik 2 dəfə az)
      const payload = { orderId: order._id, latitude, longitude, heading, speed, timestamp: ts };
      if (typeof realtime.toCustomerAndOrder === 'function') {
        realtime.toCustomerAndOrder(order.customerId, order._id, 'driver_location_updated', payload);
      } else {
        realtime.toCustomer(order.customerId, 'driver_location_updated', payload);
        realtime.toOrder(order._id, 'driver_location_updated', payload);
      }
    }
    const dist = await matchingService.distanceToCurrentDestination(driver);
    if (dist != null && dist <= settings.orderQueueActivationDistance) {
      realtime.toDriver(driver._id, 'queue_window_open', { distanceToDestinationMeters: dist });
    }
  }
  return driver;
}

async function updateCustomerLocation(customer, payload) {
  if (!customer) throw new AppError('PROFILE_NOT_FOUND', 'Customer profile not found', 403);
  const { latitude, longitude } = parseCoordinates(payload);
  customer.location = point(longitude, latitude);
  customer.locationUpdatedAt = new Date();
  await customer.save();
  return customer;
}


// Xəritədə göstərmək üçün "köhnə" sayılan konum yaşı (sürücü tətbiqi bağlayıbsa görünməsin).
const NEARBY_MAX_AGE_MS = 3 * 60 * 1000;
const NEARBY_MAX_RESULTS = 12;
const NEARBY_MAX_RESULTS_WITH_BUSY = 20;

// Daxili sürücü id-si müştəriyə açılmasın: sabit, amma geri qaytarıla bilməyən qısa id.
function publicDriverId(id) {
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
}

/**
 * Müştəri xəritəsi üçün yaxınlıqdakı sürücülər.
 *  - Standart (köhnə tətbiqlər): yalnız boş sürücülər.
 *  - includeBusy: true → aktiv sifarişi olan (məşğul) sürücülər də qaytarılır, hər birində `busy` bayrağı:
 *      busy: false → boş (xəritədə yaşıl), busy: true → sifarişdədir (xəritədə sarı).
 * Sürücünün şəxsi məlumatı (ad, nömrə, sifariş) qaytarılmır.
 */
/**
 * Qısa ömürlü keş (yüksək yük üçün): xəritəsi açıq hər müştəri ~10 san-dən bir soruşur. 5 000 açıq tətbiq →
 * saniyədə ~500 coğrafi sorğu. Eyni ~150 m xanadakı müştərilər 2.5 san ərzində EYNİ nəticəni alır, eyni anda
 * gələn eyni sorğular bir DB sorğusunu paylaşır. Hər instansiyanın öz yaddaşında saxlanılır.
 */
const NEARBY_CACHE_TTL_MS = Number(process.env.NEARBY_CACHE_TTL_MS || 2500);
const NEARBY_CACHE_MAX = 5000;
const nearbyCache = new Map(); // key -> { at, promise }

function nearbyCacheKey(lat, lng, radius, withBusy) {
  // ~150 m xana (0.0015°)
  const cell = (v) => Math.round(v / 0.0015);
  return `${cell(lat)}:${cell(lng)}:${radius}:${withBusy ? 1 : 0}`;
}

async function findNearbyDrivers(args = {}) {
  const lat = Number(args.latitude);
  const lng = Number(args.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return [];
  }
  if (!NEARBY_CACHE_TTL_MS) return findNearbyDriversUncached(args);
  const radiusKey = Math.round((Number(args.radiusM) || 3000) / 500) * 500;
  const withBusy = args.includeBusy === true || args.includeBusy === 'true' || args.includeBusy === 1;
  const key = nearbyCacheKey(lat, lng, radiusKey, withBusy);
  const now = Date.now();
  const hit = nearbyCache.get(key);
  if (hit && now - hit.at < NEARBY_CACHE_TTL_MS) return hit.promise;
  const promise = findNearbyDriversUncached(args).catch((e) => {
    nearbyCache.delete(key);
    throw e;
  });
  if (nearbyCache.size >= NEARBY_CACHE_MAX) {
    // Köhnə qeydlər təmizlənir (Map daxiletmə sırasını saxlayır)
    for (const [k, v] of nearbyCache) {
      if (now - v.at >= NEARBY_CACHE_TTL_MS || nearbyCache.size >= NEARBY_CACHE_MAX) nearbyCache.delete(k);
      else break;
    }
  }
  nearbyCache.set(key, { at: now, promise });
  return promise;
}

async function findNearbyDriversUncached({ latitude, longitude, radiusM, includeBusy } = {}) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return [];
  }
  const settings = await getSettings();
  const maxR = settings.maxDriverRadius || 5000;
  const radius = Math.min(Math.max(Number(radiusM) || 3000, 200), maxR);

  const withBusy = includeBusy === true || includeBusy === 'true' || includeBusy === 1;
  const cutoff = new Date(Date.now() - NEARBY_MAX_AGE_MS);
  const query = {
    isOnline: true,
    isActive: true,
    isVerified: true,
    deletedAt: null,
    locationUpdatedAt: { $gte: cutoff },
    // Köhnə koordinatlı sürücü xəritədə görünməsin (köhnə sənədlərdə locationFixAt yoxdur - onlar üçün locationUpdatedAt)
    $and: [{ $or: [{ locationFixAt: { $gte: cutoff } }, { locationFixAt: null }] }],
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radius,
      },
    },
  };
  if (!withBusy) query.currentOrderId = null;

  const rows = await Driver.find(query)
    .select('location locationMeta currentOrderId')
    .limit(withBusy ? NEARBY_MAX_RESULTS_WITH_BUSY : NEARBY_MAX_RESULTS)
    .lean();

  return rows.map((d) => ({
    id: publicDriverId(d._id),
    latitude: d.location.coordinates[1],
    longitude: d.location.coordinates[0],
    heading: d.locationMeta ? d.locationMeta.heading : null,
    busy: !!d.currentOrderId,
  }));
}

module.exports = { updateDriverLocation, updateCustomerLocation, findNearbyDrivers };