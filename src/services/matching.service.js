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

/** Koordinatın GPS ölçmə vaxtı; köhnə sənədlərdə (locationFixAt yoxdur) locationUpdatedAt ilə əvəz olunur. */
function fixTimeOf(driver) {
  return driver.locationFixAt || driver.locationUpdatedAt || null;
}

/**
 * requireFreshFix: yalnız YENİ sifariş axtarışında true verilir. Heartbeat koordinatı dəyişmədən "canlı" göstərə bilər,
 * ona görə ölçmə yaşı ayrıca yoxlanılır. Təklifi qəbul edərkən (order.service) verilmir: sürücü artıq seçilib.
 */
function driverCanTakeNewOrder(driver, settings, now = new Date(), { requireFreshFix = false } = {}) {
  if (!driver.isOnline || !driver.isActive || !driver.isVerified) return { ok: false, reason: 'NOT_AVAILABLE' };
  const staleSec = settings.driverLocationStaleSeconds || 45;
  if (!driver.locationUpdatedAt || (now - new Date(driver.locationUpdatedAt)) / 1000 > staleSec) {
    return { ok: false, reason: 'STALE_LOCATION' };
  }
  if (requireFreshFix) {
    const fixAt = fixTimeOf(driver);
    const maxFixSec = settings.driverFixMaxAgeSeconds || 60;
    if (!fixAt || (now - new Date(fixAt)) / 1000 > maxFixSec) return { ok: false, reason: 'STALE_FIX' };
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


// ---- Diaqnostika: sürücü niyə seçilmədi? (Heroku loglarında "[match]" ilə axtarın) ----
let lastDiagAt = 0;
async function logWhyNoCandidates(pickupLng, pickupLat, nearbyCount, skipped, excludeIds) {
  const t = Date.now();
  if (t - lastDiagAt < 10_000) return; // təkrar cəhd hər 3 san-dir, log spam olmasın
  lastDiagAt = t;
  try {
    const online = await Driver.find({ isOnline: true })
      .select('isActive isVerified location locationMeta locationUpdatedAt locationFixAt offerLockUntil currentOrderId queuedOrderIds walletBalanceMinor radiusMeters')
      .limit(20)
      .lean();
    const now = Date.now();
    const rows = online.map((d) => ({
      id: String(d._id),
      active: d.isActive,
      verified: d.isVerified,
      coords: d.location && d.location.coordinates,
      locAgeSec: d.locationUpdatedAt ? Math.round((now - new Date(d.locationUpdatedAt)) / 1000) : null,
      fixAgeSec: d.locationFixAt ? Math.round((now - new Date(d.locationFixAt)) / 1000) : null,
      accuracy: d.locationMeta && d.locationMeta.accuracy,
      lockedUntil: d.offerLockUntil,
      currentOrderId: d.currentOrderId,
      queued: (d.queuedOrderIds || []).length,
      balanceMinor: d.walletBalanceMinor,
      radiusMeters: d.radiusMeters,
      alreadyOffered: (excludeIds || []).map(String).includes(String(d._id)),
    }));
    console.log('[match] uyğun sürücü yoxdur', JSON.stringify({
      pickup: [pickupLng, pickupLat],
      nearSphereFound: nearbyCount,
      skipped,
      onlineDrivers: rows,
    }));
  } catch (e) {
    console.error('[match] diaqnostika xətası', e && e.message);
  }
}

/**
 * Sifarişə uyğun sürücüləri tapır və SIRALAYIR.
 * Sıralama: əvvəlcə boş sürücülər, sonra sifarişi bitirməyə yaxın olanlar; hər qrupda pickup-a ən yaxın birinci.
 * excludeIds - artıq təklif olunmuş və ya başqa sifarişdə təklif gözləyən sürücülər.
 * (calculateScore saxlanılıb, lakin dispatch sıralaması üçün istifadə olunmur: sifarişi ən yaxın sürücü almalıdır.)
 */
async function findEligibleDrivers(pickupLng, pickupLat, { excludeIds = [] } = {}) {
  const settings = await getSettings();
  const maxR = settings.maxDriverRadius || 5000;
  const now = new Date();
  const fixCutoff = new Date(now.getTime() - (settings.driverFixMaxAgeSeconds || 60) * 1000);

  const nearby = await Driver.find({
    isOnline: true,
    isActive: true,
    isVerified: true,
    ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
    $and: [
      // Başqa sifariş təklifi gözləyən (kilidli) sürücülər atlanır
      { $or: [{ offerLockUntil: null }, { offerLockUntil: { $lte: now } }] },
      // Köhnə koordinatlı sürücülər $nearSphere-in limit(50) nəticəsini doldurmasın (kod daxilindəki yoxlama əsasdır)
      { $or: [{ locationFixAt: { $gte: fixCutoff } }, { locationFixAt: null }] },
    ],
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [pickupLng, pickupLat] },
        $maxDistance: maxR,
      },
    },
  }).limit(50);

  const candidates = [];
  const skipped = [];
  for (const driver of nearby) {
    const gate = driverCanTakeNewOrder(driver, settings, now, { requireFreshFix: true });
    if (!gate.ok) {
      skipped.push({ driverId: String(driver._id), reason: gate.reason });
      continue;
    }

    const [dlng, dlat] = driver.location.coordinates;
    const dist = haversineMeters(dlat, dlng, pickupLat, pickupLng);
    const radius = Math.min(driver.radiusMeters || settings.defaultDriverRadius, settings.maxDriverRadius);
    if (dist > radius) {
      skipped.push({ driverId: String(driver._id), reason: 'OUT_OF_RADIUS', distM: Math.round(dist), radiusM: radius });
      continue;
    }

    let hasActive = Boolean(driver.currentOrderId);
    if (gate.requiresNearDestination) {
      const toDest = await distanceToCurrentDestination(driver);
      if (toDest == null || toDest > settings.orderQueueActivationDistance) {
        skipped.push({ driverId: String(driver._id), reason: 'BUSY_NOT_NEAR_DESTINATION', toDestM: toDest == null ? null : Math.round(toDest) });
        continue;
      }
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

  if (!candidates.length) {
    await logWhyNoCandidates(pickupLng, pickupLat, nearby.length, skipped, excludeIds);
  }

  candidates.sort((a, b) => {
    if (a.hasActiveOrder !== b.hasActiveOrder) return a.hasActiveOrder ? 1 : -1;
    return a.distanceMeters - b.distanceMeters;
  });
  return candidates;
}

module.exports = {
  findEligibleDrivers,
  calculateScore,
  driverCanTakeNewOrder,
  distanceToCurrentDestination,
};