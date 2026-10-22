/**
 * Ardıcıl sifariş göndərmə (dispatch).
 *
 * Qayda:
 *  1. Sifariş eyni anda yalnız pickup-a ən yaxın BİR sürücüyə təklif olunur.
 *  2. Sürücüyə `driverOfferSeconds` (default 20 san) verilir.
 *  3. Sürücü qəbul etsə - sifariş onundur.
 *     Rədd etsə / ləğv etsə / offline olsa / vaxt bitsə - sifariş avtomatik növbəti ən yaxın sürücüyə keçir.
 *  4. `orderDispatchTimeoutSeconds` (default 180 san = 3 dəq) ərzində heç kim qəbul etməsə, sifariş ləğv (EXPIRED) olunur.
 *
 * Etibarlılıq prinsipləri:
 *  - Vəziyyət yalnız verilənlər bazasında saxlanılır (yaddaşda setTimeout YOXDUR): restart və ya çoxlu instansiya təhlükəsizdir.
 *  - Sifarişin iki dəfə irəli keçməsi `dispatchSeq` ilə (optimistic lock) əngəllənir.
 *  - Sürücü eyni anda yalnız BİR sifariş təklifi ala bilər: `Driver.offerLockUntil` atomik kilidi
 *    (iki sifariş eyni anda eyni sürücünü seçsə, yalnız biri kilidi ala bilir). Kilid özü-özünə bitir.
 *  - Təklifin sonu serverdə də yoxlanılır (order.service.acceptOrder): gec qəbul rədd edilir.
 */
const { Order, OrderStatusHistory, Driver } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const { getSettings } = require('./settings.service');
const matchingService = require('./matching.service');
const promoService = require('./promo.service');
const realtime = require('../websocket/emitter');
const pushService = require('./push.service');
const { haversineMeters } = require('../utils/geo');

const DEFAULT_OFFER_SECONDS = 20;
const DEFAULT_DISPATCH_TIMEOUT_SECONDS = 180;
const DEFAULT_RETRY_SECONDS = 3;
const DEFAULT_ACCEPT_GRACE_MS = 1500; // şəbəkə gecikməsi üçün qəbul zamanı kiçik güzəşt
const MIN_OFFER_MS = 2000; // ləğvə bundan az qalıbsa, təklif göndərməyin mənası yoxdur
const PROCESS_CONCURRENCY = 10;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function dispatchConfig(settings) {
  return {
    offerSeconds: positive(settings.driverOfferSeconds, DEFAULT_OFFER_SECONDS),
    timeoutSeconds: positive(settings.orderDispatchTimeoutSeconds, DEFAULT_DISPATCH_TIMEOUT_SECONDS),
    retrySeconds: positive(settings.dispatchRetrySeconds, DEFAULT_RETRY_SECONDS),
    acceptGraceMs: nonNegative(settings.offerAcceptGraceMs, DEFAULT_ACCEPT_GRACE_MS),
  };
}

const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);
const earliest = (a, b) => (a <= b ? a : b);

function logError(msg, e) {
  console.error(msg, e && e.stack ? e.stack : e);
}

/** Yeni sifariş üçün dispatch sahələri (Order.create-ə əlavə olunur). */
async function initialDispatchFields(now = new Date()) {
  const { timeoutSeconds } = dispatchConfig(await getSettings());
  return {
    searchDeadlineAt: addSeconds(now, timeoutSeconds),
    dispatchDueAt: now,
  };
}

function notifyOfferEnded(driverId, orderId, reason) {
  if (!driverId) return;
  realtime.toDriver(driverId, 'order_offer_expired', { orderId, reason });
  // Açıq tam ekran təklif pəncərəsini (arxa plan) bağlat
  pushService.sendOfferEnded(driverId, orderId, reason).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Sürücü təklif kilidi                                                */
/* ------------------------------------------------------------------ */

/** Sürücünü bu sifariş üçün atomik "rezerv" edir. Uğurlu olsa true qaytarır. */
async function claimDriverForOffer(driverId, orderId, until, now) {
  const res = await Driver.updateOne(
    {
      _id: driverId,
      $or: [{ offerLockUntil: null }, { offerLockUntil: { $lte: now } }],
    },
    { $set: { offerOrderId: orderId, offerLockUntil: until } }
  );
  return (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified) === 1;
}

/** Kilidi (yalnız həmin sifarişə aiddirsə) buraxır. Xəta olsa belə axını pozmur: kilid özü bitir. */
async function releaseDriverLock(driverId, orderId) {
  if (!driverId) return;
  try {
    await Driver.updateOne(
      { _id: driverId, offerOrderId: orderId },
      { $set: { offerOrderId: null, offerLockUntil: null } }
    );
  } catch (e) {
    logError('releaseDriverLock failed', e);
  }
}

/* ------------------------------------------------------------------ */
/* Sürücüyə gedən təklif                                               */
/* ------------------------------------------------------------------ */

function buildOfferPayload(order, { distanceToPickupMeters, queued, now }) {
  const stopsArr = order.stops || [];
  const lastStop = stopsArr[stopsArr.length - 1] || {};
  const remainingMs = order.offerExpiresAt ? order.offerExpiresAt.getTime() - now.getTime() : 0;
  return {
    orderId: order._id,
    pickup: order.pickup,
    destination: order.destination,
    pickupAddress: order.pickupAddress || order.pickupLabel || '',
    destinationAddress: lastStop.address || lastStop.label || '',
    stops: order.stops,
    distanceMeters: order.distanceMeters,
    distanceToPickupMeters,
    priceMinor: order.pricingSnapshot && order.pricingSnapshot.finalPriceMinor,
    paymentMethod: order.paymentMethod,
    queued: Boolean(queued),
    // client geri sayımı offerExpiresAt - serverTime fərqindən aparmalıdır (cihaz saatına güvənmədən)
    offerSeconds: Math.max(1, Math.round(remainingMs / 1000)),
    offerExpiresAt: order.offerExpiresAt,
    serverTime: now,
  };
}

/**
 * Sürücünün hazırda gözləyən (vaxtı bitməmiş) təklifi. Tətbiq yenidən qoşulanda / açılanda
 * təklifi itirməmək üçün istifadə olunur.
 */
async function getPendingOfferForDriver(driver) {
  const now = new Date();
  const order = await Order.findOne({
    status: OrderStatus.SEARCHING_DRIVER,
    currentOfferDriverId: driver._id,
    offerExpiresAt: { $gt: now },
  }).lean();
  if (!order) return null;
  const [dlng, dlat] = (driver.location && driver.location.coordinates) || [0, 0];
  const [plng, plat] = order.pickup.coordinates;
  return buildOfferPayload(order, {
    distanceToPickupMeters: Math.round(haversineMeters(dlat, dlng, plat, plng)),
    queued: Boolean(driver.currentOrderId),
    now,
  });
}

/**
 * Sifarişi növbəti uyğun sürücüyə keçirir (və ya sürücü yoxdursa gözləmə rejiminə salır).
 *
 * @param {string|ObjectId} orderId
 * @param {object} opts
 * @param {string} [opts.reason]          'TIMEOUT' | 'REJECTED' | 'DRIVER_OFFLINE' | 'START'
 * @param {boolean} [opts.onlyIfDue]      true olduqda yalnız vaxtı çatmış sifariş irəli keçir (worker üçün)
 * @param {string|ObjectId} [opts.expectDriverId]  yalnız cari təklif bu sürücüdədirsə irəli keçir (rədd üçün)
 */
async function advanceOffer(orderId, { reason = 'START', onlyIfDue = false, expectDriverId = null } = {}) {
  const order = await Order.findById(orderId).lean();
  if (!order || order.status !== OrderStatus.SEARCHING_DRIVER) return { advanced: false };

  const now = new Date();
  if (onlyIfDue && order.dispatchDueAt && order.dispatchDueAt > now) return { advanced: false };
  if (expectDriverId && String(order.currentOfferDriverId) !== String(expectDriverId)) {
    return { advanced: false };
  }

  const settings = await getSettings();
  const cfg = dispatchConfig(settings);
  const deadline = order.searchDeadlineAt || addSeconds(new Date(order.createdAt), cfg.timeoutSeconds);
  if (deadline <= now) return expireOrder(order._id);

  // Növbəti sürücünü seçib atomik kilidləyirik. Ləğvə çox az qalıbsa, təklif göndərmirik.
  let next = null;
  let offerExpiresAt = null;
  if (deadline - now >= MIN_OFFER_MS) {
    offerExpiresAt = earliest(addSeconds(now, cfg.offerSeconds), deadline);
    const [plng, plat] = order.pickup.coordinates;
    const rejectedIds = order.rejectedDriverIds || [];
    // 1-ci tur: heç vaxt təklif almamış sürücülər. 2-ci tur (1-ci turda heç kim tapılmadısa): təklifi qaçırmış
    // sürücülər yenidən sınanır (soket qopması və s. səbəbindən təklif çatmamış ola bilər); rədd edənlər və
    // təklifi indicə bitən sürücü istisna olunur.
    const rounds = [
      [...(order.offeredToDriverIds || []), ...rejectedIds],
      [...rejectedIds, ...(order.currentOfferDriverId ? [order.currentOfferDriverId] : [])],
    ];
    for (const excludeIds of rounds) {
      const candidates = await matchingService.findEligibleDrivers(plng, plat, { excludeIds });
      for (const candidate of candidates) {
        if (await claimDriverForOffer(candidate.driver._id, order._id, offerExpiresAt, now)) {
          next = candidate;
          break;
        }
      }
      if (next) break;
    }
  }

  let update;
  if (next) {
    update = {
      $set: {
        currentOfferDriverId: next.driver._id,
        offerExpiresAt,
        searchDeadlineAt: deadline,
        dispatchDueAt: offerExpiresAt,
      },
      $addToSet: { offeredToDriverIds: next.driver._id },
      $inc: { dispatchSeq: 1 },
    };
    if (reason === 'REJECTED' && expectDriverId) update.$addToSet.rejectedDriverIds = expectDriverId;
  } else {
    // Uyğun sürücü yoxdur: təkrar cəhd (yeni sürücü online ola bilər) və ya son vaxtda ləğv.
    update = {
      $set: {
        currentOfferDriverId: null,
        offerExpiresAt: null,
        searchDeadlineAt: deadline,
        dispatchDueAt: earliest(addSeconds(now, cfg.retrySeconds), deadline),
      },
      $inc: { dispatchSeq: 1 },
    };
    if (reason === 'REJECTED' && expectDriverId) update.$addToSet = { rejectedDriverIds: expectDriverId };
  }

  // Optimistic lock: başqa proses artıq sifarişi irəli keçiribsə (dispatchSeq dəyişib), heç nə etmirik.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: OrderStatus.SEARCHING_DRIVER,
      dispatchSeq: order.dispatchSeq ? order.dispatchSeq : { $in: [0, null] },
    },
    update,
    { new: true }
  );
  if (!claimed) {
    if (next) await releaseDriverLock(next.driver._id, order._id);
    return { advanced: false };
  }

  const previousDriverId = order.currentOfferDriverId;
  if (previousDriverId) {
    await releaseDriverLock(previousDriverId, claimed._id);
    notifyOfferEnded(previousDriverId, claimed._id, reason);
  }

  if (next) {
    const offerPayload = buildOfferPayload(claimed, {
      distanceToPickupMeters: Math.round(next.distanceMeters),
      queued: next.hasActiveOrder,
      now,
    });
    realtime.toDriver(next.driver._id, 'new_order', offerPayload);
    // Tətbiq arxa planda / ekran kilidli olsa belə tam ekran təklif üçün push (socket-ə əlavə kanal)
    pushService.sendOffer(next.driver._id, offerPayload).catch((e) => logError('push sendOffer failed', e));
  }

  return { advanced: true, order: claimed, driverId: next ? next.driver._id : null };
}

/** Yeni yaradılmış sifarişin ilk təklifini göndərir. */
function startDispatch(orderId) {
  return advanceOffer(orderId, { reason: 'START' });
}

/**
 * Sürücü sifarişi rədd edir (və ya təklifi ləğv edir). Yalnız cari təklif sahibi rədd edə bilər;
 * sifariş dərhal növbəti ən yaxın sürücüyə keçir.
 */
async function rejectOffer({ orderId, driver }) {
  const result = await advanceOffer(orderId, { reason: 'REJECTED', expectDriverId: driver._id });
  return { rejected: true, advanced: Boolean(result.advanced) };
}

/**
 * Sürücü offline oldu / bağlantısı kəsildi: onda gözləyən təklifləri 20 san gözləmədən növbəti sürücüyə keçirir.
 */
async function advanceOffersOfDriver(driverId, reason = 'DRIVER_OFFLINE') {
  const orders = await Order.find({
    status: OrderStatus.SEARCHING_DRIVER,
    currentOfferDriverId: driverId,
  })
    .select('_id')
    .lean();
  for (const { _id } of orders) {
    try {
      await advanceOffer(_id, { reason, expectDriverId: driverId });
    } catch (e) {
      logError(`advanceOffersOfDriver failed for order ${String(_id)}`, e);
    }
  }
  return orders.length;
}

/** Axtarış müddəti bitdi - heç bir sürücü qəbul etmədi: sifariş ləğv (EXPIRED) olunur. */
async function expireOrder(orderId, reason = 'NO_DRIVER_ACCEPTED') {
  const now = new Date();
  const previous = await Order.findOneAndUpdate(
    { _id: orderId, status: OrderStatus.SEARCHING_DRIVER },
    {
      $set: {
        status: OrderStatus.EXPIRED,
        cancelledAt: now,
        cancelReason: reason,
        cancelledBy: 'SYSTEM',
        currentOfferDriverId: null,
        offerExpiresAt: null,
        dispatchDueAt: null,
      },
      $inc: { version: 1, dispatchSeq: 1 },
    },
    { new: false }
  );
  if (!previous) return { expired: false };

  await OrderStatusHistory.create({
    orderId: previous._id,
    fromStatus: OrderStatus.SEARCHING_DRIVER,
    toStatus: OrderStatus.EXPIRED,
    actorRole: 'SYSTEM',
    reason,
  });

  await releaseDriverLock(previous.currentOfferDriverId, previous._id);
  // Sifariş gerçəkləşmədi: müştərinin promo kodu yanmamalıdır.
  await promoService.releasePromoForOrder(previous._id).catch((e) => logError('release promo failed', e));

  notifyOfferEnded(previous.currentOfferDriverId, previous._id, 'EXPIRED');
  const payload = { orderId: previous._id, status: OrderStatus.EXPIRED, reason };
  realtime.toCustomer(previous.customerId, 'order_status_changed', payload);
  realtime.toCustomer(previous.customerId, 'order_expired', payload);
  realtime.toOrder(previous._id, 'order_status_changed', payload);
  // Regional ofis görsün: müştəriyə zəng edib sürücünü əl ilə təyin edə bilər
  if (realtime.toAdminCity) {
    realtime.toAdminCity(previous.cityId || null, 'order_unassigned', {
      orderId: previous._id,
      pickupAddress: previous.pickupAddress || '',
      priceMinor: previous.pricingSnapshot && previous.pricingSnapshot.finalPriceMinor,
    });
  }
  return { expired: true };
}

/**
 * Worker tick: vaxtı çatmış sifarişləri işləyir (təklif bitib, təkrar cəhd vaxtıdır, ya da ümumi müddət bitib).
 * Dispatch sahələri olmayan köhnə sifarişlər də (dispatchDueAt boş) tutulur. Ən köhnələr əvvəl işlənir.
 */
async function processDueOrders({ batchSize = 100 } = {}) {
  const now = new Date();
  const due = await Order.find({
    status: OrderStatus.SEARCHING_DRIVER,
    $or: [{ dispatchDueAt: { $lte: now } }, { dispatchDueAt: null }],
  })
    .sort({ dispatchDueAt: 1 })
    .select('_id')
    .limit(batchSize)
    .lean();

  let processed = 0;
  for (let i = 0; i < due.length; i += PROCESS_CONCURRENCY) {
    const chunk = due.slice(i, i + PROCESS_CONCURRENCY);
    await Promise.all(
      chunk.map(async ({ _id }) => {
        try {
          await advanceOffer(_id, { reason: 'TIMEOUT', onlyIfDue: true });
          processed += 1;
        } catch (e) {
          logError(`dispatch error for order ${String(_id)}`, e);
        }
      })
    );
  }
  return processed;
}

/**
 * Konumu köhnəlmiş (tətbiq bağlanıb / şəbəkə yoxdur) boş sürücüləri offline edir və
 * onlarda gözləyən təklifləri dərhal növbəti sürücüyə keçirir.
 * Aktiv sifarişi olan sürücülərə toxunulmur (səfər zamanı GPS qısa müddət kəsilə bilər).
 */
async function sweepStaleDrivers() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - (settings.driverLocationStaleSeconds || 45) * 1000);
  const stale = await Driver.find({
    isOnline: true,
    currentOrderId: null,
    locationUpdatedAt: { $lt: cutoff },
  })
    .select('_id')
    .lean();
  if (!stale.length) return 0;

  const ids = stale.map((d) => d._id);
  await Driver.updateMany(
    { _id: { $in: ids }, isOnline: true, currentOrderId: null, locationUpdatedAt: { $lt: cutoff } },
    { $set: { isOnline: false, onlineSince: null } }
  );
  console.log(`[sweep] mövqe köhnəldiyi üçün offline edildi: ${ids.map(String).join(', ')} (limit ${settings.driverLocationStaleSeconds || 45} san)`);
  for (const id of ids) {
    // Tətbiq "Onlayn" göstərməkdə qalmasın: sürücüyə dərhal xəbər verilir.
    realtime.toDriver(id, 'driver_offline', { reason: 'STALE_LOCATION' });
    await advanceOffersOfDriver(id, 'DRIVER_OFFLINE').catch((e) => logError('stale advance failed', e));
  }
  return ids.length;
}

module.exports = {
  initialDispatchFields,
  startDispatch,
  advanceOffer,
  rejectOffer,
  advanceOffersOfDriver,
  expireOrder,
  processDueOrders,
  sweepStaleDrivers,
  getPendingOfferForDriver,
  releaseDriverLock,
  claimDriverForOffer,
  buildOfferPayload,
  dispatchConfig,
};