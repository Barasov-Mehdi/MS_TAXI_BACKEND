const mongoose = require('mongoose');
const { Order, OrderStatusHistory, Driver, Customer, Rating } = require('../models');
const { OrderStatus, assertTransition, isActive } = require('../utils/orderStatus');
const { haversineMeters, point } = require('../utils/geo');
const { AppError } = require('../utils/errors');
const pricingService = require('./pricing.service');
const promoService = require('./promo.service');
const matchingService = require('./matching.service');
const walletService = require('./wallet.service');
const { getSettings } = require('./settings.service');
const realtime = require('../websocket/emitter');

async function recordHistory(orderId, fromStatus, toStatus, actorRole, actorId, reason, session) {
  await OrderStatusHistory.create(
    [{ orderId, fromStatus, toStatus, actorRole, actorId, reason }],
    { session }
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

  const active = await Order.findOne({
    customerId: customer._id,
    status: {
      $nin: [
        OrderStatus.COMPLETED,
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

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const [order] = await Order.create(
      [{
        customerId: customer._id,
        status: OrderStatus.SEARCHING_DRIVER,
        pickup: point(pickup.lng, pickup.lat),
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

    await offerToDrivers(order);
    return order;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function offerToDrivers(order) {
  const [plng, plat] = order.pickup.coordinates;
  const candidates = await matchingService.findEligibleDrivers(plng, plat);
  const ids = candidates.map((c) => c.driver._id);
  await Order.updateOne({ _id: order._id }, { $set: { offeredToDriverIds: ids } });
  for (const c of candidates) {
    realtime.toDriver(c.driver._id, 'new_order', {
      orderId: order._id,
      pickup: order.pickup,
      destination: order.destination,
      distanceMeters: order.distanceMeters,
      priceMinor: order.pricingSnapshot.finalPriceMinor,
      queued: c.hasActiveOrder,
    });
  }
  return candidates;
}

async function acceptOrder({ orderId, driver, user, idempotencyKey }) {
  const settings = await getSettings();
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);

    if (order.driverId && String(order.driverId) === String(driver._id)) {
      await session.commitTransaction();
      return order;
    }

    if (order.status !== OrderStatus.SEARCHING_DRIVER) {
      throw new AppError('ORDER_NOT_AVAILABLE', 'Order is no longer available', 409);
    }

    const freshDriver = await Driver.findById(driver._id).session(session);
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

    const nextStatus = queued ? OrderStatus.QUEUED : OrderStatus.DRIVER_ASSIGNED;
    assertTransition(order.status, nextStatus);

    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: OrderStatus.SEARCHING_DRIVER, driverId: null },
      {
        $set: {
          driverId: freshDriver._id,
          status: nextStatus,
          acceptedAt: new Date(),
        },
        $inc: { version: 1 },
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
      await Driver.updateOne(
        { _id: freshDriver._id, currentOrderId: null },
        { $set: { currentOrderId: updated._id } },
        { session }
      );
      if (!queued) {
        assertTransition(OrderStatus.DRIVER_ASSIGNED, OrderStatus.DRIVER_ON_THE_WAY);
        updated.status = OrderStatus.DRIVER_ON_THE_WAY;
        await updated.save({ session });
      }
    }

    await recordHistory(updated._id, OrderStatus.SEARCHING_DRIVER, updated.status, 'DRIVER', user._id, null, session);
    await session.commitTransaction();

    const others = (order.offeredToDriverIds || []).filter((id) => String(id) !== String(freshDriver._id));
    for (const id of others) {
      realtime.toDriver(id, 'order_taken_by_other_driver', { orderId: updated._id });
    }

    if (queued) {
      realtime.toCustomer(updated.customerId, 'order_status_changed', {
        orderId: updated._id,
        status: OrderStatus.DRIVER_FINISHING_CURRENT_TRIP,
        message: 'Şoförünüz şu anda mevcut yolculuğunu tamamlıyor. Yolculuğunu tamamladıktan sonra size doğru hareket edecek.',
      });
      realtime.toDriver(freshDriver._id, 'queued_order', { orderId: updated._id });
    } else {
      realtime.toCustomer(updated.customerId, 'driver_assigned', { orderId: updated._id, driverId: freshDriver._id });
      realtime.toCustomer(updated.customerId, 'order_status_changed', { orderId: updated._id, status: updated.status });
    }
    realtime.toOrder(updated._id, 'order_status_changed', { orderId: updated._id, status: updated.status });
    return updated;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

async function rejectOrder({ orderId, driver }) {
  await Order.updateOne(
    { _id: orderId, status: OrderStatus.SEARCHING_DRIVER },
    { $pull: { offeredToDriverIds: driver._id } }
  );
  return { rejected: true };
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

async function adminReassign({ order, newDriverId, adminUser, reason }) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (order.driverId) {
      await Driver.updateOne(
        { _id: order.driverId },
        { $unset: { currentOrderId: '' }, $pull: { queuedOrderIds: order._id } },
        { session }
      );
    }
    const from = order.status;
    order.driverId = newDriverId;
    order.status = OrderStatus.DRIVER_ASSIGNED;
    order.version += 1;
    await order.save({ session });
    await Driver.updateOne({ _id: newDriverId }, { $set: { currentOrderId: order._id } }, { session });
    await recordHistory(order._id, from, order.status, 'ADMIN', adminUser._id, reason, session);
    await session.commitTransaction();
    realtime.toOrder(order._id, 'order_status_changed', { orderId: order._id, status: order.status, reassigned: true });
    realtime.toDriver(newDriverId, 'new_order', { orderId: order._id, reassigned: true });
    return order;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}

module.exports = {
  createOrder,
  offerToDrivers,
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
