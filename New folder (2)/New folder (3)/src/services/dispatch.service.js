/**
 * Ardıcıl sifariş göndərmə (dispatch).
 *
 * Qayda:
 *  1. Sifariş eyni anda yalnız ən yaxın BİR sürücüyə təklif olunur.
 *  2. Sürücüyə `driverOfferSeconds` (default 25 san) verilir.
 *  3. Sürücü qəbul etsə - sifariş onundur.
 *     Rədd etsə / vaxt bitsə / uyğunsuz olsa - sifariş avtomatik növbəti ən yaxın sürücüyə keçir.
 *  4. `orderDispatchTimeoutSeconds` (default 180 san = 3 dəq) ərzində heç kim qəbul etməsə, sifariş ləğv (EXPIRED) olunur.
 *
 * Vəziyyət yalnız verilənlər bazasında saxlanılır (yaddaşda setTimeout YOXDUR), ona görə server restart olsa
 * və ya bir neçə instansiya işləsə belə düzgün işləyir. Növbəti addımı worker (`queues/worker.js`) tetikləyir.
 * Eyni sifarişin iki dəfə irəli keçməsi `dispatchSeq` ilə (optimistic lock) əngəllənir.
 */
const { Order, OrderStatusHistory } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const { getSettings } = require('./settings.service');
const matchingService = require('./matching.service');
const realtime = require('../websocket/emitter');

const DEFAULT_OFFER_SECONDS = 25;
const DEFAULT_DISPATCH_TIMEOUT_SECONDS = 180;
const DEFAULT_RETRY_SECONDS = 3;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function dispatchConfig(settings) {
  return {
    offerSeconds: positive(settings.driverOfferSeconds, DEFAULT_OFFER_SECONDS),
    timeoutSeconds: positive(settings.orderDispatchTimeoutSeconds, DEFAULT_DISPATCH_TIMEOUT_SECONDS),
    retrySeconds: positive(settings.dispatchRetrySeconds, DEFAULT_RETRY_SECONDS),
  };
}

const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);
const earliest = (a, b) => (a <= b ? a : b);

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
}

/**
 * Sifarişi növbəti uyğun sürücüyə keçirir (və ya sürücü yoxdursa gözləmə rejiminə salır).
 *
 * @param {string|ObjectId} orderId
 * @param {object} opts
 * @param {string} [opts.reason]          'TIMEOUT' | 'REJECTED' | 'START'
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

  // Başqa sifarişdə hazırda təklif gözləyən sürücülərə eyni anda ikinci təklif göndərilmir.
  const busyWithOffer = await Order.distinct('currentOfferDriverId', {
    status: OrderStatus.SEARCHING_DRIVER,
    currentOfferDriverId: { $ne: null },
    _id: { $ne: order._id },
  });
  const excludeIds = [...(order.offeredToDriverIds || []), ...busyWithOffer];

  const [plng, plat] = order.pickup.coordinates;
  const candidates = await matchingService.findEligibleDrivers(plng, plat, { excludeIds });
  const next = candidates[0] || null;

  let update;
  if (next) {
    const offerExpiresAt = addSeconds(now, cfg.offerSeconds);
    update = {
      $set: {
        currentOfferDriverId: next.driver._id,
        offerExpiresAt,
        searchDeadlineAt: deadline,
        dispatchDueAt: earliest(offerExpiresAt, deadline),
      },
      $addToSet: { offeredToDriverIds: next.driver._id },
      $inc: { dispatchSeq: 1 },
    };
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
  if (!claimed) return { advanced: false };

  const previousDriverId = order.currentOfferDriverId;
  if (previousDriverId && (!next || String(previousDriverId) !== String(next.driver._id))) {
    notifyOfferEnded(previousDriverId, claimed._id, reason);
  }

  if (next) {
    realtime.toDriver(next.driver._id, 'new_order', {
      orderId: claimed._id,
      pickup: claimed.pickup,
      destination: claimed.destination,
      stops: claimed.stops,
      distanceMeters: claimed.distanceMeters,
      distanceToPickupMeters: Math.round(next.distanceMeters),
      priceMinor: claimed.pricingSnapshot && claimed.pricingSnapshot.finalPriceMinor,
      paymentMethod: claimed.paymentMethod,
      queued: next.hasActiveOrder,
      offerSeconds: cfg.offerSeconds,
      offerExpiresAt: claimed.offerExpiresAt,
      serverTime: new Date(),
    });
  }

  return { advanced: true, order: claimed, driverId: next ? next.driver._id : null };
}

/** Yeni yaradılmış sifarişin ilk təklifini göndərir. */
function startDispatch(orderId) {
  return advanceOffer(orderId, { reason: 'START' });
}

/**
 * Sürücü sifarişi rədd edir. Yalnız cari təklif sahibi rədd edə bilər;
 * sifariş dərhal növbəti ən yaxın sürücüyə keçir.
 */
async function rejectOffer({ orderId, driver }) {
  const result = await advanceOffer(orderId, { reason: 'REJECTED', expectDriverId: driver._id });
  return { rejected: true, advanced: result.advanced };
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

  notifyOfferEnded(previous.currentOfferDriverId, previous._id, 'EXPIRED');
  const payload = { orderId: previous._id, status: OrderStatus.EXPIRED, reason };
  realtime.toCustomer(previous.customerId, 'order_status_changed', payload);
  realtime.toCustomer(previous.customerId, 'order_expired', payload);
  realtime.toOrder(previous._id, 'order_status_changed', payload);
  return { expired: true };
}

/**
 * Worker tick: vaxtı çatmış sifarişləri işləyir (təklif bitib, təkrar cəhd vaxtıdır, ya da ümumi müddət bitib).
 * Dispatch sahələri olmayan köhnə sifarişlər də (dispatchDueAt boş) tutulur.
 */
async function processDueOrders({ batchSize = 100 } = {}) {
  const now = new Date();
  const due = await Order.find({
    status: OrderStatus.SEARCHING_DRIVER,
    $or: [{ dispatchDueAt: { $lte: now } }, { dispatchDueAt: null }],
  })
    .select('_id')
    .limit(batchSize)
    .lean();

  let processed = 0;
  for (const { _id } of due) {
    try {
      await advanceOffer(_id, { reason: 'TIMEOUT', onlyIfDue: true });
      processed += 1;
    } catch (e) {
      console.error('dispatch error for order', String(_id), e);
    }
  }
  return processed;
}

module.exports = {
  initialDispatchFields,
  startDispatch,
  advanceOffer,
  rejectOffer,
  expireOrder,
  processDueOrders,
  dispatchConfig,
};
