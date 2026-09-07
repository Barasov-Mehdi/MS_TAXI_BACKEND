const { Driver, Order } = require('../models');
const { getSettings } = require('./settings.service');
const { haversineMeters } = require('../utils/geo');
const { OrderStatus } = require('../utils/orderStatus');

function calculateScore(d, settings) {
  const wDist = settings.matchingWeightDistance ?? 0.45;
  const wRating = settings.matchingWeightRating ?? 0.3;
  const wOnline = settings.matchingWeightOnline ?? 0.1;
  const wPriority = settings.matchingWeightPriority ?? 0.1;
  const wActivePenalty = settings.matchingWeightActivePenalty ?? 0.05;
  const distScore = 1 / (1 + d.distanceMeters / 1000);
  const ratingScore = (d.ratingAvg || 0) / 5;
  const onlineScore = Math.min((d.onlineDurationSeconds || 0) / 3600, 1);
  const priorityScore = Math.min((d.priority || 0) / 10, 1);
  const activePenalty = d.hasActiveOrder ? 1 : 0;
  return (
    wDist * distScore +
    wRating * ratingScore +
    wOnline * onlineScore +
    wPriority * priorityScore -
    wActivePenalty * activePenalty
  );
}

function driverCanTakeNewOrder(driver, settings, now = new Date()) {
  if (!driver.isOnline || !driver.isActive || !driver.isVerified) return { ok: false, reason: 'NOT_AVAILABLE' };
  const staleSec = settings.driverLocationStaleSeconds || 45;
  if (!driver.locationUpdatedAt || (now - new Date(driver.locationUpdatedAt)) / 1000 > staleSec) {
    return { ok: false, reason: 'STALE_LOCATION' };
  }
  const acc = driver.locationMeta && driver.locationMeta.accuracy;
  if (acc != null && acc > (settings.maxLocationAccuracyMeters || 80)) {
    return { ok: false, reason: 'BAD_ACCURACY' };
  }
  if ((driver.walletBalanceMinor || 0) < (settings.minimumDriverBalance || 0) && !settings.negativeBalanceAllowed) {
    return { ok: false, reason: 'LOW_BALANCE' };
  }
  const queued = driver.queuedOrderIds || [];
  if (queued.length >= (settings.maxQueuedOrders || 1)) {
    return { ok: false, reason: 'QUEUE_FULL' };
  }
  if (!driver.currentOrderId) return { ok: true, queued: false };

  return { ok: true, requiresNearDestination: true };
}

async function distanceToCurrentDestination(driver) {
  if (!driver.currentOrderId) return null;
  const current = await Order.findById(driver.currentOrderId).lean();
  if (!current || current.status !== OrderStatus.TRIP_STARTED) return null;
  const [dlng, dlat] = driver.location.coordinates;
  const [olng, olat] = current.destination.coordinates;
  return haversineMeters(dlat, dlng, olat, olng);
}

async function findEligibleDrivers(pickupLng, pickupLat) {
  const settings = await getSettings();
  const maxR = settings.maxDriverRadius || 5000;
  const now = new Date();

  const nearby = await Driver.find({
    isOnline: true,
    isActive: true,
    isVerified: true,
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [pickupLng, pickupLat] },
        $maxDistance: maxR,
      },
    },
  }).limit(50);

  const candidates = [];
  for (const driver of nearby) {
    const gate = driverCanTakeNewOrder(driver, settings, now);
    if (!gate.ok) continue;

    const [dlng, dlat] = driver.location.coordinates;
    const dist = haversineMeters(dlat, dlng, pickupLat, pickupLng);
    const radius = Math.min(driver.radiusMeters || settings.defaultDriverRadius, settings.maxDriverRadius);
    if (dist > radius) continue;

    let hasActive = Boolean(driver.currentOrderId);
    if (gate.requiresNearDestination) {
      const toDest = await distanceToCurrentDestination(driver);
      if (toDest == null || toDest > settings.orderQueueActivationDistance) continue;
      hasActive = true;
    }

    const onlineDurationSeconds = driver.onlineSince
      ? Math.max(0, (now - new Date(driver.onlineSince)) / 1000)
      : 0;

    const score = calculateScore(
      {
        distanceMeters: dist,
        ratingAvg: driver.ratingAvg,
        onlineDurationSeconds,
        priority: driver.priority,
        hasActiveOrder: hasActive,
      },
      settings
    );

    candidates.push({
      driver,
      distanceMeters: dist,
      score,
      hasActiveOrder: hasActive,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

module.exports = {
  findEligibleDrivers,
  calculateScore,
  driverCanTakeNewOrder,
  distanceToCurrentDestination,
};
