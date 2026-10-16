const router = require('express').Router();
const mongoose = require('mongoose');
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const { getSettings } = require('../services/settings.service');
const orderService = require('../services/order.service');
const dispatchService = require('../services/dispatch.service');
const locationService = require('../services/location.service');
const { Order, Vehicle, WalletTransaction, OrderIssue, Customer } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');

router.use(authenticate, requireRoles('DRIVER'));

/**
 * Sürücüyə qaytarılan sifarişlərə sərnişinin adı və telefonu əlavə edir.
 * Order yalnız customerId (Customer sənədi) saxlayır; ad/telefon Customer.userId → User-dədir.
 * Bu route-lar yalnız sürücünün öz sifarişlərini qaytardığı üçün məlumat yalnız həmin sürücüyə açılır.
 */
async function withCustomers(input) {
  const single = !Array.isArray(input);
  const list = single ? [input] : input;
  const docs = list.filter(Boolean);
  const ids = [...new Set(docs.map((o) => String(o.customerId)))];
  const customers = ids.length
    ? await Customer.find({ _id: { $in: ids } }).populate('userId', 'firstName lastName username phone').lean()
    : [];
  const byId = new Map(customers.map((c) => [String(c._id), c.userId]));
  const out = list.map((o) => {
    if (!o) return o;
    const obj = typeof o.toObject === 'function' ? o.toObject() : o;
    const u = byId.get(String(o.customerId));
    const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || u?.username || '';
    return { ...obj, customerName: name, customerPhone: u?.phone || '' };
  });
  return single ? out[0] : out;
}

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
    // Üzərində gözləyən təklif varsa, 20 san gözləmədən növbəti sürücüyə keçir.
    await dispatchService.advanceOffersOfDriver(req.driver._id, 'DRIVER_OFFLINE');
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
    const rows = await Order.find({ driverId: req.driver._id }).sort({ createdAt: -1 }).limit(50);
    ok(res, { orders: await withCustomers(rows) });
  } catch (e) { next(e); }
});

// Tətbiq yenidən açılanda / bağlantı bərpa olunanda: gözləyən (vaxtı bitməmiş) təklif varsa qaytarılır.
router.get('/offers/current', async (req, res, next) => {
  try {
    ok(res, { offer: await dispatchService.getPendingOfferForDriver(req.driver) });
  } catch (e) { next(e); }
});

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError('ORDER_NOT_FOUND', 'Order not found', 404));
  }
  return next();
});

router.post('/orders/:id/accept', async (req, res, next) => {
  try {
    const order = await orderService.acceptOrder({
      orderId: req.params.id,
      driver: req.driver,
      user: req.user,
    });
    ok(res, { order: await withCustomers(order) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/reject', async (req, res, next) => {
  try {
    ok(res, await orderService.rejectOrder({ orderId: req.params.id, driver: req.driver }));
  } catch (e) { next(e); }
});

router.post('/orders/:id/arrive', async (req, res, next) => {
  try {
    ok(res, { order: await withCustomers(await orderService.arrive({ orderId: req.params.id, driver: req.driver, user: req.user })) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/start', async (req, res, next) => {
  try {
    ok(res, { order: await withCustomers(await orderService.startTrip({ orderId: req.params.id, driver: req.driver, user: req.user })) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/complete', async (req, res, next) => {
  try {
    const done = await orderService.completeTrip({
      orderId: req.params.id,
      driver: req.driver,
      user: req.user,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    ok(res, { order: await withCustomers(done) });
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