const mongoose = require('mongoose');
const { Order, OrderStatusHistory, Driver, Customer, Rating, TripEarning, OrderIssue, User } = require('../models');
const { OrderStatus, assertTransition, isActive } = require('../utils/orderStatus');
const { haversineMeters, point } = require('../utils/geo');
const { AppError } = require('../utils/errors');
const pricingService = require('./pricing.service');
const promoService = require('./promo.service');
const matchingService = require('./matching.service');
const dispatchService = require('./dispatch.service');
const walletService = require('./wallet.service');
const { getSettings } = require('./settings.service');
const { normalizePhone } = require('../utils/validators');
const realtime = require('../websocket/emitter');
const adminFeed = require('../websocket/adminFeed');
const pushService = require('./push.service');

/** Push xətası əsas axını pozmasın. */
const fireAndForget = (p) => Promise.resolve(p).catch((e) => console.error('[push]', e && e.message ? e.message : e));

async function recordHistory(orderId, fromStatus, toStatus, actorRole, actorId, reason, session) {
  await OrderStatusHistory.create(
    [{ orderId, fromStatus, toStatus, actorRole, actorId, reason }],
    session ? { session } : {}
  );
}

/**
 * Sürücünün aktiv sifarişi (currentOrderId) boşalıbsa, növbədəki ilk QUEUED sifarişi aktivləşdirir.
 * Əvvəl bu yalnız completeTrip-də edilirdi: cari səfər LƏĞV olunanda növbədəki sifariş əbədi QUEUED qalırdı.
 * Session daxilində işləyir; bildirişlər commit-dən sonra announceQueuedActivated ilə göndərilir.
 */
async function activateNextQueued(driverId, session) {
  if (!driverId) return null;
  const drv = await Driver.findById(driverId).session(session);
  if (!drv || drv.currentOrderId) return null;
  const ids = [...(drv.queuedOrderIds || [])];
  for (const qid of ids) {
    drv.queuedOrderIds = (drv.queuedOrderIds || []).filter((id) => String(id) !== String(qid));
    const queued = await Order.findById(qid).session(session);
    if (queued && queued.status === OrderStatus.QUEUED) {
      assertTransition(queued.status, OrderStatus.DRIVER_HEADING_TO_CUSTOMER);
      queued.status = OrderStatus.DRIVER_HEADING_TO_CUSTOMER;
      queued.version += 1;
      await queued.save({ session });
      drv.currentOrderId = queued._id;
      await drv.save({ session });
      await recordHistory(queued._id, OrderStatus.QUEUED, OrderStatus.DRIVER_HEADING_TO_CUSTOMER, 'SYSTEM', null, 'auto-activate', session);
      return queued;
    }
  }
  await drv.save({ session });
  return null;
}

function announceQueuedActivated(driverId, queued) {
  if (!queued) return;
  realtime.toCustomer(queued.customerId, 'queued_order_activated', {
    orderId: queued._id,
    message: 'Sürücünüz cari səfərini bitirdi və indi sizə doğru gəlir.',
  });
  realtime.toCustomer(queued.customerId, 'order_status_changed', {
    orderId: queued._id,
    status: OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
  });
  realtime.toDriver(driverId, 'queued_order_activated', { orderId: queued._id });
  realtime.toOrder(queued._id, 'order_status_changed', {
    orderId: queued._id,
    status: OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
  });
}

/**
 * Səfərin qazanc qeydini (TripEarning) yazır. Sifariş sonradan bazadan silinsə də sürücünün
 * gündəlik qazancı, sifariş sayı və tutulan komissiya itmir. orderId unikal olduğu üçün təkrar yazılmır.
 */
async function recordEarning(order, driverId, commission, session) {
  const gross = (order.pricingSnapshot && order.pricingSnapshot.finalPriceMinor) || 0;
  const commissionMinor = commission && commission.commissionMinor ? commission.commissionMinor : 0;
  const stops = order.stops || [];
  const last = stops[stops.length - 1] || {};
  await TripEarning.updateOne(
    { orderId: order._id },
    {
      $setOnInsert: {
        driverId,
        orderId: order._id,
        completedAt: order.completedAt || new Date(),
        grossMinor: gross,
        commissionMinor,
        netMinor: gross - commissionMinor,
        commissionRate: commission && commission.rate != null ? commission.rate : null,
        ratingAtTrip: commission && commission.ratingAvg != null ? commission.ratingAvg : null,
        distanceMeters: order.distanceMeters || 0,
        durationMin: order.durationMin || 0,
        paymentMethod: order.paymentMethod || 'CASH',
        pickupAddress: order.pickupAddress || order.pickupLabel || '',
        destinationAddress: last.address || last.label || '',
      },
    },
    { upsert: true, session }
  );
}

/** "Başqası üçün sifariş": ad və nömrə sürücüyə göstərilir. Yanlış/natamam məlumat atılır. */
function cleanPassenger(p) {
  if (!p || p.forOther !== true) return { forOther: false, name: '', phone: '' };
  const name = String(p.name || '').trim().slice(0, 60);
  const phone = normalizePhone(p.phone) || '';
  if (!name && !phone) return { forOther: false, name: '', phone: '' };
  return { forOther: true, name, phone };
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
  passenger,
  idempotencyKey,
  // Daxili istifadə: bu sürücülərə təklif getməsin (məs. səfəri dayandıran sürücü)
  excludeDriverIds = [],
  continuedFromOrderId = null,
  scheduledRideId = null,
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

  // Hələlik onlayn ödəniş inteqrasiyası yoxdur: CARD/WALLET qəbul olunarsa sərnişin ödənişsiz gedə bilər.
  if (paymentMethod && String(paymentMethod).toUpperCase() !== 'CASH') {
    throw new AppError('PAYMENT_METHOD_UNSUPPORTED', 'Hazırda yalnız nağd ödəniş mövcuddur', 400);
  }

  vehicleType = pricingService.normalizeVehicleType(vehicleType);
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
  // Regional ofis üçün: sifariş hansı şəhərə aiddir (sürücü tapılmasa da ofis görsün)
  const orderCity = await require('./city.service').cityForPoint(pickup.lat, pickup.lng).catch(() => null);

  let order;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    [order] = await Order.create(
      [{
        ...dispatchFields,
        customerId: customer._id,
        cityId: orderCity ? orderCity.id : null,
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
        passenger: cleanPassenger(passenger),
        promoCode: promoCode ? String(promoCode).toUpperCase() : null,
        pricingSnapshot: priced,
        idempotencyKey: idempotencyKey || null,
        rejectedDriverIds: excludeDriverIds,
        continuedFromOrderId,
        scheduledRideId,
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
  adminFeed.orderChanged(order._id);
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
      // Sürücü artıq seçilib: mövqe yaşı / GPS dəqiqliyi burada yoxlanılmır (ekran kilidli qəbul rədd edilməsin)
      const gate = matchingService.driverCanTakeNewOrder(freshDriver, settings, now, { forAccept: true });
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
      message: 'Sürücünüz hazırda cari səfərini bitirir. Səfəri bitirdikdən sonra sizə doğru hərəkət edəcək.',
    });
    realtime.toDriver(driverId, 'queued_order', { orderId: updated._id });
    fireAndForget(pushService.notifyQueuedOrder(driverId, updated._id));
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

/**
 * early: səfər yarıda dayandırılır ("Səfəri dayandır"). Qiymət gedilən km-ə görə yenidən hesablanmış məbləğlə
 * əvəz olunur, komissiya da həmin məbləğdən tutulur. { chargedMinor, reason, traveledMeters, latitude, longitude }
 */
async function completeTrip({ orderId, driver, user, early = null }) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (String(order.driverId) !== String(driver._id)) throw new AppError('FORBIDDEN', 'Not your order', 403);

    if (early) {
      if (order.status !== OrderStatus.TRIP_STARTED) {
        throw new AppError('TRIP_NOT_STARTED', 'Yalnız davam edən səfəri dayandırmaq olar', 409);
      }
      const original = (order.pricingSnapshot && order.pricingSnapshot.finalPriceMinor) || 0;
      order.set('pricingSnapshot.originalFinalPriceMinor', original);
      order.set('pricingSnapshot.finalPriceMinor', early.chargedMinor);
      order.stoppedEarly = {
        at: new Date(),
        reason: early.reason,
        traveledMeters: early.traveledMeters,
        chargedMinor: early.chargedMinor,
        originalPriceMinor: original,
        latitude: early.latitude,
        longitude: early.longitude,
      };
    }

    if (order.status === OrderStatus.TRIP_COMPLETED || order.status === OrderStatus.RATING_PENDING || order.status === OrderStatus.COMPLETED) {
      await session.commitTransaction();
      return order;
    }
    assertTransition(order.status, OrderStatus.TRIP_COMPLETED);

    order.status = OrderStatus.TRIP_COMPLETED;
    order.completedAt = new Date();
    order.version += 1;
    let commission = { commissionMinor: 0, rate: null, ratingAvg: null };
    if (!order.commissionApplied) {
      commission = await walletService.applyTripCommission(driver._id, order, session);
      order.commissionApplied = true;
    }
    await order.save({ session });
    await recordEarning(order, driver._id, commission, session);
    await recordHistory(order._id, OrderStatus.TRIP_STARTED, OrderStatus.TRIP_COMPLETED, 'DRIVER', user._id, null, session);

    assertTransition(order.status, OrderStatus.RATING_PENDING);
    order.status = OrderStatus.RATING_PENDING;
    order.version += 1;
    await order.save({ session });
    await recordHistory(order._id, OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING, 'SYSTEM', user._id, 'awaiting rating', session);

    // Sürücünü azad et (yalnız bu sifariş cari idisə) və növbədəki sifarişi aktivləşdir
    await Driver.updateOne(
      { _id: driver._id },
      { $pull: { queuedOrderIds: order._id } },
      { session }
    );
    await Driver.updateOne(
      { _id: driver._id, currentOrderId: order._id },
      { $set: { currentOrderId: null } },
      { session }
    );
    const activated = await activateNextQueued(driver._id, session);
    const drv = await Driver.findById(driver._id).session(session);
    await session.commitTransaction();

    announceQueuedActivated(driver._id, activated);
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

/** Sürücü bu vəziyyətlərdə ləğv edərsə sifariş bağlanmır, növbəti sürücüyə ötürülür (sərnişin hələ maşında deyil). */
const REDISPATCHABLE = new Set([
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.DRIVER_ON_THE_WAY,
  OrderStatus.DRIVER_HEADING_TO_CUSTOMER,
  OrderStatus.DRIVER_ARRIVED,
  OrderStatus.QUEUED,
  OrderStatus.DRIVER_FINISHING_CURRENT_TRIP,
]);

/**
 * Sürücü qəbul etdiyi sifarişi ləğv etdi: sərnişin yenidən sifariş yaratmasın deyə sifariş
 * SEARCHING_DRIVER vəziyyətinə qaytarılır və dərhal növbəti ən yaxın sürücüyə təklif olunur.
 * Ləğv edən sürücü bu sifarişə bir daha təklif almır (rejectedDriverIds). Axtarış müddəti yenidən başlayır.
 */
async function redispatchAfterDriverCancel({ order, user, reason }) {
  const settings = await getSettings();
  const { timeoutSeconds } = dispatchService.dispatchConfig(settings);
  const driverId = order.driverId;
  const from = order.status;
  const now = new Date();
  const session = await mongoose.startSession();
  let activated = null;
  let updated = null;
  try {
    await session.withTransaction(async () => {
      updated = await Order.findOneAndUpdate(
        { _id: order._id, status: from, driverId },
        {
          $set: {
            status: OrderStatus.SEARCHING_DRIVER,
            driverId: null,
            acceptedAt: null,
            currentOfferDriverId: null,
            offerExpiresAt: null,
            searchDeadlineAt: new Date(now.getTime() + timeoutSeconds * 1000),
            dispatchDueAt: now,
          },
          $addToSet: { rejectedDriverIds: driverId, offeredToDriverIds: driverId },
          $inc: { version: 1, dispatchSeq: 1, redispatchCount: 1 },
        },
        { new: true, session }
      );
      if (!updated) throw new AppError('ORDER_STATE_CHANGED', 'Order state changed, please refresh', 409);

      await recordHistory(order._id, from, OrderStatus.SEARCHING_DRIVER, 'DRIVER', user._id, `driver_cancel: ${reason || ''}`.trim(), session);
      await Driver.updateOne({ _id: driverId }, { $pull: { queuedOrderIds: order._id } }, { session });
      await Driver.updateOne({ _id: driverId, currentOrderId: order._id }, { $set: { currentOrderId: null } }, { session });
      activated = await activateNextQueued(driverId, session);
    });
  } finally {
    session.endSession();
  }

  announceQueuedActivated(driverId, activated);
  // Sürücüyə socket hadisəsi göndərilmir: ləğvi özü edib (REST cavabı kifayətdir), əks halda tətbiq
  // "Sifariş ləğv olundu" xəbərdarlığını ləğv edən sürücünün özünə göstərərdi.
  // Sərnişinə: sifariş ləğv olunmayıb, yeni sürücü axtarılır
  const payload = {
    orderId: order._id,
    status: OrderStatus.SEARCHING_DRIVER,
    reason: 'DRIVER_CANCELLED',
    message: 'Sürücü sifarişi ləğv etdi. Sizə yeni sürücü axtarılır.',
  };
  realtime.toCustomer(order.customerId, 'driver_cancelled_searching', payload);
  realtime.toCustomer(order.customerId, 'order_status_changed', payload);
  realtime.toOrder(order._id, 'order_status_changed', payload);

  try {
    await dispatchService.startDispatch(order._id);
  } catch (e) {
    console.error('redispatch failed for order', String(order._id), e); // worker növbəti tick-də təkrar cəhd edəcək
  }
  return (await Order.findById(order._id)) || updated;
}

/** Gedilən yol: GPS odometri; o yoxdursa götürmə nöqtəsindən indiki yerə düz xətt × 1.3. Tam marşrutdan çox ola bilməz. */
function traveledMetersOf(order, lat, lng) {
  const full = order.distanceMeters || 0;
  let m = order.tripMeters || 0;
  if (m < 50 && Number.isFinite(lat) && Number.isFinite(lng)) {
    const [plng, plat] = order.pickup.coordinates;
    m = Math.round(haversineMeters(plat, plng, lat, lng) * 1.3);
  }
  return full ? Math.min(m, full) : m;
}

/**
 * Səfəri yarıda dayandır (maşın xarab oldu, qəza ...):
 *  1) sərnişindən gedilən km qədər ödəniş (tarif üzrə, ilkin qiymətdən çox olmur), komissiya bu məbləğdən;
 *  2) səfər bitmiş sayılır, sürücü azad olur;
 *  3) sərnişinin olduğu yerdən qalan ünvanlara avtomatik YENİ sifariş yaradılır (bu sürücü xaric);
 *  4) admin üçün problem qeydi (OrderIssue: TRIP_STOPPED) yaranır.
 */
async function stopTrip({ orderId, driver, user, reason, latitude, longitude, doneStops = 0 }) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (String(order.driverId) !== String(driver._id)) throw new AppError('FORBIDDEN', 'Not your order', 403);
  if (order.status !== OrderStatus.TRIP_STARTED) {
    throw new AppError('TRIP_NOT_STARTED', 'Yalnız davam edən səfəri dayandırmaq olar', 409);
  }
  const cleanReason = String(reason || '').trim().slice(0, 200) || 'Səbəb göstərilməyib';
  let lat = Number(latitude);
  let lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    const fresh = await Driver.findById(driver._id).lean();
    [lng, lat] = (fresh && fresh.location && fresh.location.coordinates) || [NaN, NaN];
  }

  // ---- Gedilən km qədər qiymət ----
  const traveledMeters = traveledMetersOf(order, lat, lng);
  const original = (order.pricingSnapshot && order.pricingSnapshot.finalPriceMinor) || 0;
  const elapsedMin = order.startedAt ? Math.max(0, (Date.now() - new Date(order.startedAt).getTime()) / 60000) : 0;
  let chargedMinor = 0;
  if (traveledMeters > 0) {
    const p = await pricingService.calculateTripPrice({
      distanceMeters: traveledMeters,
      durationMin: Math.round(elapsedMin),
      stopCount: 0,
      vehicleType: order.vehicleType || 'basic',
    });
    chargedMinor = Math.min(original, p.finalPriceMinor);
  }

  const done = await completeTrip({
    orderId,
    driver,
    user,
    early: { chargedMinor, reason: cleanReason, traveledMeters, latitude: lat, longitude: lng },
  });

  // ---- Sərnişin üçün davam sifarişi (qalan ünvanlara) ----
  let newOrder = null;
  try {
    const stops = (order.stops || []).map((s) => ({ lat: s.lat, lng: s.lng, label: s.label, address: s.address }));
    const remaining = stops.slice(Math.max(0, Math.min(Number(doneStops) || 0, stops.length)));
    if (remaining.length && Number.isFinite(lat) && Number.isFinite(lng)) {
      const customer = await Customer.findById(order.customerId);
      const custUser = customer ? await User.findById(customer.userId) : null;
      if (customer && custUser) {
        newOrder = await createOrder({
          customer,
          user: custUser,
          pickup: { lat, lng, address: 'Səfərin dayandığı yer', label: 'Səfərin dayandığı yer' },
          destination: remaining[remaining.length - 1],
          stops: remaining,
          vehicleType: order.vehicleType || 'basic',
          paymentMethod: 'CASH',
          passenger: order.passenger && order.passenger.forOther ? order.passenger : undefined,
          idempotencyKey: `continue:${order._id}`,
          excludeDriverIds: [driver._id],
          continuedFromOrderId: order._id,
        });
        await Order.updateOne({ _id: order._id }, { $set: { continuedToOrderId: newOrder._id } });
      }
    }
  } catch (e) {
    console.error('[stopTrip] davam sifarişi yaradılmadı', String(order._id), e && e.message);
  }

  // ---- Admin üçün qeyd + sui-istifadə nəzarəti ----
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const stopsToday = await Order.countDocuments({ driverId: driver._id, 'stoppedEarly.at': { $gte: dayStart } });
  await OrderIssue.create({
    orderId: order._id,
    reporterRole: 'DRIVER',
    reporterUserId: user._id,
    type: 'TRIP_STOPPED',
    description:
      `Səfər dayandırıldı: ${cleanReason}. Gedilən yol: ${(traveledMeters / 1000).toFixed(2)} km, ` +
      `alınan: ${(chargedMinor / 100).toFixed(2)} AZN (ilkin: ${(original / 100).toFixed(2)} AZN). ` +
      `Sürücünün bu gün dayandırdığı səfər sayı: ${stopsToday}.` +
      (newOrder ? ` Sərnişin üçün yeni sifariş: ${newOrder._id}` : ''),
  })
    .then((doc) => adminFeed.issue(doc))
    .catch((e) => console.error('[stopTrip] issue create failed', e && e.message));
  adminFeed.orderChanged(order._id);
  adminFeed.driverChanged(driver._id, 'order');
  realtime.toAdminCity(driver.cityId, 'trip_stopped', {
    orderId: order._id,
    driverId: driver._id,
    reason: cleanReason,
    chargedMinor,
    traveledMeters,
    stopsToday,
    warning: stopsToday > 2,
    newOrderId: newOrder ? newOrder._id : null,
  });

  // ---- Sərnişinə ----
  const payload = {
    orderId: order._id,
    reason: cleanReason,
    chargedMinor,
    traveledMeters,
    newOrderId: newOrder ? newOrder._id : null,
    message: newOrder
      ? `Səfər dayandırıldı (${cleanReason}). Ödəniş: ${(chargedMinor / 100).toFixed(2)} ₼. Sizə yeni sürücü axtarılır.`
      : `Səfər dayandırıldı (${cleanReason}). Ödəniş: ${(chargedMinor / 100).toFixed(2)} ₼.`,
  };
  realtime.toCustomer(order.customerId, 'trip_stopped', payload);
  if (newOrder) {
    realtime.toCustomer(order.customerId, 'order_continued', { oldOrderId: order._id, newOrderId: newOrder._id, status: newOrder.status });
  }

  return { order: done, chargedMinor, traveledMeters, originalPriceMinor: original, newOrderId: newOrder ? newOrder._id : null };
}

async function cancelOrder({ order, user, role, reason }) {
  // Səfər başlayıb (sərnişin maşındadır): sürücü sifarişi ləğv edə bilməz. Problem varsa "Problem bildir"
  // ilə admina xəbər verir, lazım olsa admin ləğv edir.
  if (role === 'DRIVER' && order.status === OrderStatus.TRIP_STARTED) {
    throw new AppError(
      'TRIP_IN_PROGRESS',
      'Səfər başlayıb, sifarişi ləğv etmək olmaz. Problem varsa "Problem bildir" bölməsindən xəbər verin',
      409
    );
  }
  // Sürücü qəbul etdiyi (hələ başlamamış) sifarişi ləğv edir → növbəti sürücüyə ötürülür
  if (role === 'DRIVER' && REDISPATCHABLE.has(order.status) && order.driverId) {
    const settings = await getSettings();
    const max = Number(settings.maxRedispatch ?? 5);
    if ((order.redispatchCount || 0) < max) {
      return redispatchAfterDriverCancel({ order, user, reason });
    }
    // Həddən çox ötürülüb: sifariş həqiqətən ləğv olunur (aşağıdakı adi axın)
  }

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
      // Tətbiq arxa planda ikən açıq tam ekran təklif pəncərəsi də bağlansın
      fireAndForget(pushService.sendOfferEnded(before.currentOfferDriverId, order._id, 'CANCELLED'));
    }
    realtime.toOrder(order._id, 'order_cancelled', payload);
    // status + səbəb də ötürülür (köhnə tətbiqlər yalnız orderId oxuyur — geriyə uyğundur)
    realtime.toCustomer(order.customerId, 'order_cancelled', { orderId: order._id, status: to, reason });
    return Order.findById(order._id);
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  let activated = null;
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
      // Yalnız BU sifarişə aid sahələr təmizlənir: növbədəki (QUEUED) sifariş ləğv olunanda sürücünün
      // hazırda davam edən səfəri (currentOrderId) silinməməlidir.
      await Driver.updateOne({ _id: order.driverId }, { $pull: { queuedOrderIds: order._id } }, { session });
      await Driver.updateOne(
        { _id: order.driverId, currentOrderId: order._id },
        { $set: { currentOrderId: null } },
        { session }
      );
      // Cari səfər ləğv olundusa növbədəki sifariş "QUEUED"-də ilişib qalmasın
      activated = await activateNextQueued(order.driverId, session);
    }
    await session.commitTransaction();
    announceQueuedActivated(order.driverId, activated);
    realtime.toOrder(order._id, 'order_cancelled', { orderId: order._id, status: to, reason });
    if (order.driverId) {
      realtime.toDriver(order.driverId, 'order_cancelled', { orderId: order._id });
      // Sürücü özü ləğv edibsə bildiriş lazım deyil; sərnişin / admin ləğv edəndə telefona bildiriş gedir.
      if (role !== 'DRIVER') fireAndForget(pushService.notifyOrderCancelled(order.driverId, order._id, role));
    }
    realtime.toCustomer(order.customerId, 'order_cancelled', { orderId: order._id, status: to, reason });
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
    adminFeed.feedback({ order, score, comment });
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
            // Sürücü tətbiqində DRIVER_ASSIGNED üçün düymə yoxdur (arrive yalnız ON_THE_WAY-dən): adi qəbul kimi birbaşa "yolda".
            status: OrderStatus.DRIVER_ON_THE_WAY,
            acceptedAt: new Date(),
          },
          $inc: { version: 1, dispatchSeq: 1 },
        },
        { session, new: false }
      );
      if (!before) throw new AppError('ORDER_STATE_CHANGED', 'Order state changed, please refresh', 409);

      if (before.driverId && !sameDriver) {
        // Köhnə sürücünün başqa (davam edən) səfəri silinməsin: yalnız bu sifarişə aid sahələr təmizlənir.
        await Driver.updateOne({ _id: before.driverId }, { $pull: { queuedOrderIds: order._id } }, { session });
        await Driver.updateOne(
          { _id: before.driverId, currentOrderId: order._id },
          { $set: { currentOrderId: null } },
          { session }
        );
      }
      await Driver.updateOne(
        { _id: newDriver._id },
        { $set: { currentOrderId: order._id }, $pull: { queuedOrderIds: order._id } },
        { session }
      );
      await recordHistory(order._id, before.status, OrderStatus.DRIVER_ASSIGNED, 'ADMIN', adminUser._id, reason, session);
      await recordHistory(order._id, OrderStatus.DRIVER_ASSIGNED, OrderStatus.DRIVER_ON_THE_WAY, 'SYSTEM', adminUser._id, 'admin reassign', session);
      const oldDriverActivated = before.driverId && !sameDriver ? await activateNextQueued(before.driverId, session) : null;
      outcome = { before, newDriverId: newDriver._id, oldDriverActivated };
    });
  } finally {
    session.endSession();
  }

  const { before } = outcome;
  announceQueuedActivated(before.driverId, outcome.oldDriverActivated);
  const offeredDriverId = before.currentOfferDriverId;
  await dispatchService.releaseDriverLock(offeredDriverId, order._id);
  const updated = await Order.findById(order._id);
  realtime.toOrder(order._id, 'order_status_changed', { orderId: order._id, status: updated.status, reassigned: true });
  realtime.toCustomer(updated.customerId, 'order_status_changed', { orderId: order._id, status: updated.status, reassigned: true });
  realtime.toDriver(outcome.newDriverId, 'new_order', { orderId: order._id, reassigned: true });
  fireAndForget(pushService.notifyOrderAssigned(outcome.newDriverId, order._id));
  if (before.driverId && String(before.driverId) !== String(outcome.newDriverId)) {
    realtime.toDriver(before.driverId, 'order_cancelled', { orderId: order._id });
    fireAndForget(pushService.notifyOrderRemoved(before.driverId, order._id));
  }
  if (offeredDriverId && String(offeredDriverId) !== String(outcome.newDriverId)) {
    realtime.toDriver(offeredDriverId, 'order_offer_expired', { orderId: order._id, reason: 'REASSIGNED' });
  }
  return updated;
}

module.exports = {
  cleanPassenger,
  createOrder,
  acceptOrder,
  rejectOrder,
  startTrip,
  arrive,
  completeTrip,
  stopTrip,
  traveledMetersOf,
  cancelOrder,
  rateOrder,
  adminReassign,
  activateNextQueued,
  isActive,
};