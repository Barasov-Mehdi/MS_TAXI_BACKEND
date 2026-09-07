const router = require('express').Router();
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const { getSettings } = require('../services/settings.service');
const orderService = require('../services/order.service');
const locationService = require('../services/location.service');
const { Order, Vehicle, WalletTransaction, OrderIssue } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');

router.use(authenticate, requireRoles('DRIVER'));

router.get('/me', async (req, res) => {
  ok(res, { user: req.user, driver: req.driver });
});

router.patch('/me', async (req, res, next) => {
  try {
    const { firstName, lastName } = req.body;
    if (firstName != null) req.user.firstName = firstName;
    if (lastName != null) req.user.lastName = lastName;
    await req.user.save();
    ok(res, { user: req.user });
  } catch (e) { next(e); }
});

router.post('/online', async (req, res, next) => {
  try {
    if (!req.driver.isVerified || !req.driver.isActive) {
      throw new AppError('DRIVER_NOT_VERIFIED', 'Driver is not verified/active', 403);
    }
    req.driver.isOnline = true;
    req.driver.onlineSince = new Date();
    await req.driver.save();
    ok(res, { driver: req.driver });
  } catch (e) { next(e); }
});

router.post('/offline', async (req, res, next) => {
  try {
    if (req.driver.currentOrderId) {
      const current = await Order.findById(req.driver.currentOrderId);
      if (current && current.status === OrderStatus.TRIP_STARTED) {
        throw new AppError('ACTIVE_TRIP', 'Cannot go offline during an active trip', 409);
      }
    }
    req.driver.isOnline = false;
    req.driver.onlineSince = null;
    await req.driver.save();
    ok(res, { driver: req.driver });
  } catch (e) { next(e); }
});

router.post('/location', async (req, res, next) => {
  try {
    await locationService.updateDriverLocation(req.driver, req.body);
    ok(res, { updated: true });
  } catch (e) { next(e); }
});

router.patch('/radius', async (req, res, next) => {
  try {
    const settings = await getSettings();
    const r = Number(req.body.radiusMeters);
    if (!r || r <= 0 || r > settings.maxDriverRadius) {
      throw new AppError('INVALID_RADIUS', 'Radius exceeds max allowed', 400);
    }
    req.driver.radiusMeters = r;
    await req.driver.save();
    ok(res, { radiusMeters: req.driver.radiusMeters });
  } catch (e) { next(e); }
});

router.post('/vehicle', async (req, res, next) => {
  try {
    const v = await Vehicle.create({ ...req.body, driverId: req.driver._id });
    req.driver.vehicleId = v._id;
    await req.driver.save();
    ok(res, { vehicle: v }, {}, 201);
  } catch (e) { next(e); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const orders = await Order.find({ driverId: req.driver._id }).sort({ createdAt: -1 }).limit(50);
    ok(res, { orders });
  } catch (e) { next(e); }
});

router.post('/orders/:id/accept', async (req, res, next) => {
  try {
    const order = await orderService.acceptOrder({
      orderId: req.params.id,
      driver: req.driver,
      user: req.user,
      idempotencyKey: req.headers['idempotency-key'],
    });
    ok(res, { order });
  } catch (e) { next(e); }
});

router.post('/orders/:id/reject', async (req, res, next) => {
  try {
    ok(res, await orderService.rejectOrder({ orderId: req.params.id, driver: req.driver }));
  } catch (e) { next(e); }
});

router.post('/orders/:id/arrive', async (req, res, next) => {
  try {
    ok(res, { order: await orderService.arrive({ orderId: req.params.id, driver: req.driver, user: req.user }) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/start', async (req, res, next) => {
  try {
    ok(res, { order: await orderService.startTrip({ orderId: req.params.id, driver: req.driver, user: req.user }) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/complete', async (req, res, next) => {
  try {
    ok(res, { order: await orderService.completeTrip({ orderId: req.params.id, driver: req.driver, user: req.user }) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, driverId: req.driver._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    ok(res, { order: await orderService.cancelOrder({ order, user: req.user, role: 'DRIVER', reason: req.body.reason }) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/issues', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, driverId: req.driver._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const issue = await OrderIssue.create({
      orderId: order._id,
      reporterRole: 'DRIVER',
      reporterUserId: req.user._id,
      type: req.body.type,
      description: req.body.description,
    });
    ok(res, { issue }, {}, 201);
  } catch (e) { next(e); }
});

router.get('/wallet', async (req, res) => {
  ok(res, { balanceMinor: req.driver.walletBalanceMinor });
});

router.get('/wallet/transactions', async (req, res, next) => {
  try {
    const txs = await WalletTransaction.find({ driverId: req.driver._id }).sort({ createdAt: -1 }).limit(100);
    ok(res, { transactions: txs });
  } catch (e) { next(e); }
});

module.exports = router;
