const crypto = require('crypto');
const { Driver, Customer } = require('../models');
const { getSettings } = require('./settings.service');
const { point } = require('../utils/geo');
const realtime = require('../websocket/emitter');
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

  if (driver.locationMeta && driver.locationMeta.timestamp && ts < driver.locationMeta.timestamp) {
    return driver;
  }
  const settings = await getSettings();
  if (accuracy != null && accuracy > (settings.maxLocationAccuracyMeters || 80) * 3) {
    return driver;
  }
  const now = new Date();
  // Atomik yeniləmə: tam sənədi save() etmirik ki, paralel dəyişikliklər (currentOrderId, isOnline) üstünə yazılmasın.
  await Driver.updateOne(
    { _id: driver._id },
    {
      $set: {
        location: point(longitude, latitude),
        locationMeta: { accuracy, heading, speed, timestamp: ts },
        locationUpdatedAt: now,
      },
    }
  );
  driver.location = point(longitude, latitude);
  driver.locationMeta = { accuracy, heading, speed, timestamp: ts };
  driver.locationUpdatedAt = now;

  if (driver.currentOrderId) {
    const order = await Order.findById(driver.currentOrderId);
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

  const rows = await Driver.find({
    isOnline: true,
    isActive: true,
    isVerified: true,
    currentOrderId: null,
    locationUpdatedAt: { $gte: new Date(Date.now() - NEARBY_MAX_AGE_MS) },
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