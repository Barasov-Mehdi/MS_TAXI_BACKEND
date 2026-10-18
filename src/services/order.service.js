const mongoose = require('mongoose');
const { Order, OrderStatusHistory, Driver, Customer, Rating } = require('../models');
const { OrderStatus, assertTransition, isActive } = require('../utils/orderStatus');
const { haversineMeters, point } = require('../utils/geo');
const { AppError } = require('../utils/errors');
const pricingService = require('./pricing.service');
const promoService = require('./promo.service');
const matchingService = require('./matching.service');
const dispatchService = require('./dispatch.service');
const walletService = require('./wallet.service');
const { getSettings } = require('./settings.service');
const realtime = require('../websocket/emitter');

async function recordHistory(orderId, fromStatus, toStatus, actorRole, actorId, reason, session) {
  await OrderStatusHistory.create(
    [{ orderId, fromStatus, toStatus, actorRole, actorId, reason }],
    session ? { session } : {}
  );
}

async function createOrder({
  customer,
  user,
  pickup,
  destination,
  stops,
  vehicleType = 'basic',
  distanceMeters: clientDistance,
  durationMin: clientDuration,
  promoCode,
  paymentMethod,
  idempotencyKey,
}) {
  if (idempotencyKey) {
    const existing = await Order.findOne({ customerId: customer._id, idempotencyKey });
    if (existing) return existing;
  }

  // Nömrə ilə qeydiyyatdan keçən müştəri sifariş verməzdən əvvəl istifadəçi adı əlavə etməlidir.
  if (!user.username) {
    throw new AppError('USERNAME_REQUIRED', 'Sifariş vermək üçün istifadəçi adı əlavə edin', 422);
  }

  const active = await Order.findOne({
    customerId: customer._id,
    status: {
      $nin: [
        OrderStatus.COMPLETED,
        // Səfər bitib, yalnız qiymətləndirmə gözlənilir: yeni sifarişə mane olmur.
        OrderStatus.TRIP_COMPLETED,
        OrderStatus.RATING_PENDING,
        OrderStatus.CUSTOMER_CANCELLED,
        OrderStatus.DRIVER_CANCELLED,
        OrderStatus.ADMIN_CANCELLED,
        OrderStatus.EXPIRED,
      ],
    },
  });
  if (active) throw new AppError('ACTIVE_ORDER_EXISTS', 'Customer already has an active order', 409);

  if (!pricingService.VEHICLE_TYPES.includes(vehicleType)) {
    throw new AppError('INVALID_VEHICLE_TYPE', 'Unknown vehicle type', 400);
  }
  const stopList = stops && stops.length ? stops : [destination];
  const { distanceMeters, durationMin } = pricingService.resolveTripMetrics({
    points: [pickup, ...stopList],
    distanceMeters: clientDistance,
    durationMin: clientDuration,
  });
  // Qiymət həmişə serverdə hesablanır; müştəridən qiymət qəbul edilmir.
  const tripInput = { distanceMeters, durationMin, stopCount: stopList.length - 1, vehicleType };

  const quote = await pricingService.calculateTripPrice({ ...tripInput, promoDiscountMinor: 0 });
  let promo = null;
  let discountMinor = 0;
  if (promoCode) {
    const r = await promoService.validateAndQuote(promoCode, customer._id, quote.finalPriceMinor, user._id);
    promo = r.promo;
    discountMinor = r.discountMinor;
  }
  const priced = await pricingService.calculateTripPrice({ ...tripInput, promoDiscountMinor: discountMinor });

  const dispatchFields = await dispatchService.initialDispatchFields();

  let order;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    [order] = await Order.create(
      [{
        ...dispatchFields,
        customerId: customer._id,
        status: OrderStatus.SEARCHING_DRIVER,
        pickup: point(pickup.lng, pickup.lat),
        pickupAddress: pickup.address ? String(pickup.address).slice(0, 300) : '',
        pickupLabel: pickup.label ? String(pickup.label).slice(0, 200) : '',
        destination: point(destination.lng, destination.lat),
        distanceMeters,
        durationMin,
        vehicleType,
        stops: stopList.map((s) => ({ lat: s.lat, lng: s.lng, label: s.label, address: s.address })),
        paymentMethod: paymentMethod || 'CASH',
        promoCode: promoCode ? String(promoCode).toUpperCase() : null,
        pricingSnapshot: priced,
        idempotencyKey: idempotencyKey || null,
      }],
      { session }
    );

    if (promo) {
      const usage = await promoService.consumePromo(session, promo, customer._id, order._id, discountMinor);
      order.promoUsageId = usage._id;
      await order.save({ session });
    }

    await recordHistory(order._id, OrderStatus.CREATED, OrderStatus.SEARCHING_DRIVER, 'CUSTOMER', user._id, null, session);
    await session.commitTransaction();
  } catch (e) {
    await session.abortTransaction();
    // Eyni Idempotency-Key ilə paralel sorğu: ikinci sorğu mövcud sifarişi qaytarır (dublikat yaranmır).
    if (e && e.code === 11000 && idempotencyKey) {
      const existing = await Order.findOne({ customerId: customer._id, idempotencyKey });
      if (existing) return existing;
    }
    throw e;
  } finally {
    session.endSession();
  }

  // Sifariş artıq commit olunub: dispatch xətası sifarişi itirməməlidir (worker təkrar cəhd edəcək).
  try {
    await dispatchService.startDispatch(order._id);
  } catch (e) {
    console.error('initial dispatch failed for order', String(order._id), e);
  }
  return (await Order.findById(order._id)) || order;
}

async function acceptOrder({ orderId, driver, user }) {
  const settings = await getSettings();
  const { acceptGraceMs } = dispatchService.dispatchConfig(settings);
  const session = await mongoose.startSession();
  let outcome;

  try {
    // withTransaction: dispatch eyni sifarişi eyni anda dəyişərsə yaranan WriteConflict avtomatik təkrarlanır
    // (əvvəl bu, sürücüyə 500 xətası kimi qayıdırdı). Callback yalnız DB əməliyyatları edir; bildirişlər commit-dən sonradır.
    await session.withTransaction(async () => {
      const now = new Date();
      const order = await Order.findById(orderId).session(session);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);

      if (order.driverId && String(order.driverId) === String(driver._id)) {
        outcome = { order, alreadyAccepted: true };
        return;
      }

      if (order.status !== OrderStatus.SEARCHING_DRIVER) {
        throw new AppError('ORDER_NOT_AVAILABLE', 'Order is no longer available', 409);
      }

      // Ardıcıl dispatch: sifarişi yalnız hazırda təklif alan sürücü qəbul edə bilər.
      if (!order.currentOfferDriverId || String(order.currentOfferDriverId) !== String(driver._id)) {
        throw new AppError('OFFER_NOT_ACTIVE', 'Offer expired or not assigned to this driver', 409);
      }

      // Təklifin müddəti SERVERDƏ yoxlanılır (worker növbəti tick-ə qədər gecikə bilər).
      const offerDeadline = order.offerExpiresAt ? order.offerExpiresAt.getTime() + acceptGraceMs : 0;
      if (offerDeadline < now.getTime()) {
        throw new AppError('OFFER_EXPIRED', 'Offer time has expired', 409);
      }
      if (order.searchDeadlineAt && order.searchDeadlineAt <= now) {
        throw new AppError('ORDER_NOT_AVAILABLE', 'Order search time is over', 409);
      }

      const freshDriver = await Driver.findById(driver._id).session(session);
      if (!freshDriver) throw new AppError('DRIVER_NOT_ELIGIBLE', 'NOT_AVAILABLE', 409);
      const gate = matchingService.driverCanTakeNewOrder(freshDriver, settings);
      if (!gate.ok) throw new AppError('DRIVER_NOT_ELIGIBLE', gate.reason, 409);

      let queued = false;
      if (gate.requiresNearDestination) {
        const dist = await matchingService.distanceToCurrentDestination(freshDriver);
        if (dist == null || dist > settings.orderQueueActivationDistance) {
          throw new AppError('NOT_NEAR_DESTINATION', 'Driver is not within queue activation distance', 409);
        }
        queued = true;
      }

      assertTransition(order.status, queued ? OrderStatus.QUEUED : OrderStatus.DRIVER_ASSIGNED);
      if (!queued) assertTransition(OrderStatus.DRIVER_ASSIGNED, OrderStatus.DRIVER_ON_THE_WAY);
      const finalStatus = queued ? OrderStatus.QUEUED : OrderStatus.DRIVER_ON_THE_WAY;

      // Atomik götürmə: eyni anda dispatch irəli keçibsə, ləğv olunubsa və ya təklif bitibsə - uğursuz olur.
      const updated = await Order.findOneAndUpdate(
        {
          _id: order._id,
          status: OrderStatus.SEARCHING_DRIVER,
          driverId: null,
          currentOfferDriverId: freshDriver._id,
          offerExpiresAt: { $gt: new Date(now.getTime() - acceptGraceMs) },
        },
        {
          $set: {
            driverId: freshDriver._id,
            status: finalStatus,
            acceptedAt: now,
            currentOfferDriverId: null,
            offerExpiresAt: null,
            dispatchDueAt: null,
          },
          $inc: { version: 1, dispatchSeq: 1 },
        },
        { session, new: true }
      );
      if (!updated) throw new AppError('ORDER_TAKEN', 'Order taken by another driver', 409);

      if (queued) {
        await Driver.updateOne(
          { _id: freshDriver._id },
          { $addToSet: { queuedOrderIds: updated._id } },
          { session }
        );
      } else {
        const r = await Driver.updateOne(
          { _id: freshDriver._id, currentOrderId: null },
          { $set: { currentOrderId: updated._id } },
          { session }
        );
        // Sürücü bu arada başqa sifariş götürübsə, sifariş "sahibsiz" qalmasın: transaction geri qaytarılır.
        if (!r.matchedCount) throw new AppError('DRIVER_BUSY', 'Driver already has an active order', 409);
      }

      await recordHistory(updated._id, OrderStatus.SEARCHING_DRIVER, updated.status, 'DRIVER', user._id, null, session);
      outcome = { order: updated, queued, driverId: freshDriver._id };
    });
  } finally {
    session.endSession();
  }

  if (outcome.alreadyAccepted) return outcome.order;

  const { order: updated, queued, driverId } = outcome;
  await dispatchService.releaseDriverLock(driverId, updated._id);

  if (queued) {
    realtime.toCustomer(updated.customerId, 'order_status_changed', {
      orderId: updated._id,
      status: OrderStatus.DRIVER_FINISHING_CURRENT_TRIP,
      message: 'Şoförünüz şu anda mevcut yolculuğunu tamamlıyor. Yolculuğunu tamamladıktan sonra size doğru hareket edecek.',
    });
    realtime.toDriver(driverId, 'queued_order', { orderId: updated._id });
  } else {
    realtime.toCustomer(updated.customerId, 'driver_assigned', { orderId: updated._id, driverId });
    realtime.toCustomer(updated.customerId, 'order_status_changed', { orderId: updated._id, status: updated.status });
  }
  realtime.toOrder(updated._id, 'order_status_changed', { orderId: updated._id, status: updated.status });
  return updated;
}

async function rejectOrder({ orderId, driver }) {
  // Sifariş dərhal növbəti ən yaxın sürücüyə keçir.
  return dispatchService.rejectOffer({ orderId, driver });
}

async function transitionByDriver({ orderId, driver, user, toStatus, extra = {} }) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (String(order.driverId) !== String(driver._id)) {
      throw new AppError('FORBIDDEN', 'Not your order', 403);
    }
    if (order.status === toStatus) {
      await session.commitTransaction();
      return order;
    }
    assertTransition(order.status, toStatus);
    const from = order.status;
    order.status = toStatus;
    Object.assign(order, extra);
    order.version += 1;
    await order.save({ session });
    await recordHistory(order._id, from, toStatus, 'DRIVER', user._id, extra.cancelReason, session);
    await session.commitTransaction();
    realtime.toOrder(order._id, 'order_status_changed', { orderId: order._id, status: toStatus });
    realtime.toCustomer(order.customerId, 'order_status_changed', { orderId: order._id, status: toStatus });
    return order;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function startTrip({ orderId, driver, user }) {
  return transitionByDriver({
    orderId,
    driver,
    user,
    toStatus: OrderStatus.TRIP_STARTED,
    extra: { startedAt: new Date() },
  });
}

async function arrive({ orderId, driver, user }) {
  return transitionByDriver({ orderId, driver, user, toStatus: OrderStatus.DRIVER_ARRIVED });
}

async function completeTrip({ orderId, driver, user }) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (String(order.driverId) !== String(driver._id)) throw new AppError('FORBIDDEN', 'Not your order', 403);

    if (order.status === OrderStatus.TRIP_COMPLETED || order.status === OrderStatus.RATING_PENDING || order.status === OrderStatus.COMPLETED) {
      await session.commitTransaction();
      return order;
    }
    assertTransition(order.status, OrderStatus.TRIP_COMPLETED);

    order.status = OrderStatus.TRIP_COMPLETED;
    order.completedAt = new Date();
    order.version += 1;
    if (!order.commissionApplied) {
      await walletService.applyTripCommission(driver._id, order, session);
      order.commissionApplied = true;
    }
    await order.save({ session });
    await recordHistory(order._id, OrderStatus.TRIP_STARTED, OrderStatus.TRIP_COMPLETED, 'DRIVER', user._id, null, session);

    assertTransition(order.status, OrderStatus.RATING_PENDING);
    order.status = OrderStatus.RATING_PENDING;
    order.version += 1;
    await order.save({ session });
    await recordHistory(order._id, OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING, 'SYSTEM', user._id, 'awaiting rating', session);

    const drv = await Driver.findById(driver._id).session(session);
    drv.currentOrderId = null;
    drv.queuedOrderIds = (drv.queuedOrderIds || []).filter((id) => String(id) !== String(order._id));

    const nextQueuedId = drv.queuedOrderIds[0];
    if (nextQueuedId) {
      const queued = await Order.findById(nextQueuedId).session(session);
      if (queued && queued.status === OrderStatus.QUEUED) {
        assertTransition(queued.status, OrderStatus.DRIVER_HEADING_TO_CUSTOMER);
        queued.status = OrderStatus.DRIVER_HEADING_TO_CUSTOMER;
        queued.version += 1;
        await queued.save({ session });
        drv.currentOrderId = queued._id;
        drv.queuedOrderIds = drv.queuedOrderIds.filter((id) => String(id) !== String(queued._id));
        await recordHistory(queued._id, OrderStatus.QUEUED, OrderStatus.DRIVER_HEADING_TO_CUSTOMER, 'SYSTEM', null, 'auto-activate', session);
        realtime.toCustomer(queued.customerId, 'queued_order_activated', {
          orderId: queued._id,
          message: 'Şoförünüz mevcut yolculuğunu tamamladı ve şimdi size doğru geliyor.',
        });
        realtime.toDriver(drv._id, 'queued_order_activated', { orderId: queued._id });
        realtime.toOrder(queued._id, 'order_status_changed', {
          orderId: queued._id,
          status: OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
        });
      }
    }
    await drv.save({ session });
    await session.commitTransaction();

    realtime.toOrder(order._id, 'trip_completed', { orderId: order._id });
    realtime.toCustomer(order.customerId, 'trip_completed', { orderId: order._id });
    realtime.toDriver(driver._id, 'balance_updated', { balanceMinor: drv.walletBalanceMinor });
    return order;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function cancelOrder({ order, user, role, reason }) {
  const map = {
    CUSTOMER: OrderStatus.CUSTOMER_CANCELLED,
    DRIVER: OrderStatus.DRIVER_CANCELLED,
    ADMIN: OrderStatus.ADMIN_CANCELLED,
  };
  const to = map[role];
  if (order.status === to) return order;
  assertTransition(order.status, to);

  // Axtarış mərhələsində (sürücü hələ qəbul etməyib) ləğv: sifariş KEÇMİR, hamıdan dərhal silinir.
  // Əməliyyat atomikdir: eyni anda sürücü qəbul edibsə və ya dispatch sifarişi irəli keçiribsə, nəticə səhv olmur.
  if (order.status === OrderStatus.SEARCHING_DRIVER) {
    const before = await Order.findOneAndUpdate(
      { _id: order._id, status: OrderStatus.SEARCHING_DRIVER },
      {
        $set: {
          status: to,
          currentOfferDriverId: null,
          offerExpiresAt: null,
          dispatchDueAt: null,
          cancelledAt: new Date(),
          cancelReason: reason,
          cancelledBy: role,
        },
        $inc: { version: 1, dispatchSeq: 1 },
      },
      { new: false }
    );
    if (!before) {
      throw new AppError('ORDER_STATE_CHANGED', 'Order state changed, please refresh', 409);
    }
    await recordHistory(order._id, OrderStatus.SEARCHING_DRIVER, to, role, user._id, reason);
    await dispatchService.releaseDriverLock(before.currentOfferDriverId, order._id);
    // Sürücü tapılmadan ləğv olunan sifarişdə promo kodu yanmamalıdır.
    await promoService.releasePromoForOrder(order._id).catch((e) => console.error('release promo failed', e));

    // Sifarişi o an görən sürücüyə (varsa) real vaxtda bildirilir ki, kart dərhal yoxa çıxsın.
    const payload = { orderId: order._id, status: to, reason };
    if (before.currentOfferDriverId) {
      realtime.toDriver(before.currentOfferDriverId, 'order_cancelled', payload);
      realtime.toDriver(before.currentOfferDriverId, 'order_offer_expired', { orderId: order._id, reason: 'CANCELLED' });
    }
    realtime.toOrder(order._id, 'order_cancelled', payload);
    realtime.toCustomer(order.customerId, 'order_cancelled', { orderId: order._id });
    return Order.findById(order._id);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const from = order.status;
    order.status = to;
    order.cancelledAt = new Date();
    order.cancelReason = reason;
    order.cancelledBy = role;
    order.version += 1;
    await order.save({ session });
    await recordHistory(order._id, from, to, role, user._id, reason, session);

    if (order.driverId) {
      await Driver.updateOne(
        { _id: order.driverId },
        { $unset: { currentOrderId: '' }, $pull: { queuedOrderIds: order._id } },
        { session }
      );
    }
    await session.commitTransaction();
    realtime.toOrder(order._id, 'order_cancelled', { orderId: order._id, status: to, reason });
    if (order.driverId) realtime.toDriver(order.driverId, 'order_cancelled', { orderId: order._id });
    realtime.toCustomer(order.customerId, 'order_cancelled', { orderId: order._id });
    return order;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function rateOrder({ order, customer, score, comment }) {
  if (order.status !== OrderStatus.RATING_PENDING && order.status !== OrderStatus.TRIP_COMPLETED) {
    throw new AppError('RATING_NOT_ALLOWED', 'Order is not in rating state', 409);
  }
  const existing = await Rating.findOne({ orderId: order._id });
  if (existing) return existing;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const [rating] = await Rating.create(
      [{ orderId: order._id, customerId: customer._id, driverId: order.driverId, score, comment }],
      { session }
    );

    // Commission already applied in completeTrip() using driver.ratingAvg at trip end.
    // Here we only update the average for future trips.

    const agg = await Rating.aggregate([
      { $match: { driverId: order.driverId } },
      { $group: { _id: '$driverId', avg: { $avg: '$score' }, n: { $sum: 1 } } },
    ]).session(session);
    if (agg[0]) {
      await Driver.updateOne(
        { _id: order.driverId },
        { $set: { ratingAvg: agg[0].avg, ratingCount: agg[0].n } },
        { session }
      );
    }
    order.status = OrderStatus.COMPLETED;
    order.ratingId = rating._id;
    await order.save({ session });
    await session.commitTransaction();
    return rating;
  } catch (e) {
    if (e.code === 11000) {
      await session.abortTransaction();
      return Rating.findOne({ orderId: order._id });
    }
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

const NON_REASSIGNABLE = new Set([
  OrderStatus.TRIP_STARTED,
  OrderStatus.TRIP_COMPLETED,
  OrderStatus.RATING_PENDING,
  OrderStatus.COMPLETED,
  OrderStatus.CUSTOMER_CANCELLED,
  OrderStatus.DRIVER_CANCELLED,
  OrderStatus.ADMIN_CANCELLED,
  OrderStatus.EXPIRED,
  OrderStatus.DISPUTED,
  OrderStatus.WAITING_FOR_ADMIN,
]);

async function adminReassign({ order, newDriverId, adminUser, reason }) {
  if (!mongoose.isValidObjectId(newDriverId)) {
    throw new AppError('INVALID_DRIVER', 'driverId is invalid', 400);
  }
  if (NON_REASSIGNABLE.has(order.status)) {
    throw new AppError('ORDER_NOT_REASSIGNABLE', `Order in status ${order.status} cannot be reassigned`, 409);
  }

  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      const newDriver = await Driver.findById(newDriverId).session(session);
      if (!newDriver || !newDriver.isActive || !newDriver.isVerified) {
        throw new AppError('DRIVER_NOT_ELIGIBLE', 'Target driver is not available', 409);
      }
      const sameDriver = order.driverId && String(order.driverId) === String(newDriver._id);
      if (!sameDriver && newDriver.currentOrderId) {
        throw new AppError('DRIVER_BUSY', 'Target driver already has an active order', 409);
      }

      // Atomik: dispatch/qəbul/ləğv eyni anda sifarişi dəyişibsə, köhnə (stale) sənəd üzərinə yazılmır.
      const before = await Order.findOneAndUpdate(
        { _id: order._id, status: order.status, version: order.version },
        {
          $set: {
            currentOfferDriverId: null,
            offerExpiresAt: null,
            dispatchDueAt: null,
            driverId: newDriver._id,
            status: OrderStatus.DRIVER_ASSIGNED,
          },
          $inc: { version: 1, dispatchSeq: 1 },
        },
        { session, new: false }
      );
      if (!before) throw new AppError('ORDER_STATE_CHANGED', 'Order state changed, please refresh', 409);

      if (before.driverId && !sameDriver) {
        await Driver.updateOne(
          { _id: before.driverId },
          { $unset: { currentOrderId: '' }, $pull: { queuedOrderIds: order._id } },
          { session }
        );
      }
      await Driver.updateOne({ _id: newDriver._id }, { $set: { currentOrderId: order._id } }, { session });
      await recordHistory(order._id, before.status, OrderStatus.DRIVER_ASSIGNED, 'ADMIN', adminUser._id, reason, session);
      outcome = { before, newDriverId: newDriver._id };
    });
  } finally {
    session.endSession();
  }

  const { before } = outcome;
  const offeredDriverId = before.currentOfferDriverId;
  await dispatchService.releaseDriverLock(offeredDriverId, order._id);
  const updated = await Order.findById(order._id);
  realtime.toOrder(order._id, 'order_status_changed', { orderId: order._id, status: updated.status, reassigned: true });
  realtime.toCustomer(updated.customerId, 'order_status_changed', { orderId: order._id, status: updated.status, reassigned: true });
  realtime.toDriver(outcome.newDriverId, 'new_order', { orderId: order._id, reassigned: true });
  if (offeredDriverId && String(offeredDriverId) !== String(outcome.newDriverId)) {
    realtime.toDriver(offeredDriverId, 'order_offer_expired', { orderId: order._id, reason: 'REASSIGNED' });
  }
  return updated;
}

module.exports = {
  createOrder,
  acceptOrder,
  rejectOrder,
  startTrip,
  arrive,
  completeTrip,
  cancelOrder,
  rateOrder,
  adminReassign,
  isActive,
};