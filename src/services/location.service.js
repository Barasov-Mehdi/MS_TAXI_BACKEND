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
    const order = await Order.findById(driver.currentOrderId);
    // Faktiki yol (odometr): yalnız səfər zamanı, dəqiq GPS ilə və real hərəkətdə (sıçrayışlar atılır)
    if (order && order.status === 'TRIP_STARTED' && prevCoords && !(prevCoords[0] === 0 && prevCoords[1] === 0)) {
      const step = haversineMeters(prevCoords[1], prevCoords[0], latitude, longitude);
      if (step >= 5 && step <= 2000 && (accuracy == null || accuracy <= 50)) {
        await Order.updateOne({ _id: order._id, status: 'TRIP_STARTED' }, { $inc: { tripMeters: Math.round(step) } });
      }
    }
    if (order) {
      realtime.toCustomer(order.customerId, 'driver_location_updated', {
        orderId: order._id,
        latitude,
        longitude,
        heading,
        speed,
        timestamp: ts,
      });
      realtime.toOrder(order._id, 'driver_location_updated', {
        latitude, longitude, heading, speed, timestamp: ts,
      });
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

// Daxili sürücü id-si müştəriyə açılmasın: sabit, amma geri qaytarıla bilməyən qısa id.
function publicDriverId(id) {
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
}

async function findNearbyDrivers({ latitude, longitude, radiusM } = {}) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return [];
  }
  const settings = await getSettings();
  const maxR = settings.maxDriverRadius || 5000;
  const radius = Math.min(Math.max(Number(radiusM) || 3000, 200), maxR);

  const cutoff = new Date(Date.now() - NEARBY_MAX_AGE_MS);
  const rows = await Driver.find({
    isOnline: true,
    isActive: true,
    isVerified: true,
    currentOrderId: null,
    locationUpdatedAt: { $gte: cutoff },
    // Köhnə koordinatlı sürücü xəritədə görünməsin (köhnə sənədlərdə locationFixAt yoxdur - onlar üçün locationUpdatedAt)
    $and: [{ $or: [{ locationFixAt: { $gte: cutoff } }, { locationFixAt: null }] }],
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radius,
      },
    },
  })
    .select('location locationMeta')
    .limit(NEARBY_MAX_RESULTS)
    .lean();

  return rows.map((d) => ({
    id: publicDriverId(d._id),
    latitude: d.location.coordinates[1],
    longitude: d.location.coordinates[0],
    heading: d.locationMeta ? d.locationMeta.heading : null,
  }));
}

module.exports = { updateDriverLocation, updateCustomerLocation, findNearbyDrivers };