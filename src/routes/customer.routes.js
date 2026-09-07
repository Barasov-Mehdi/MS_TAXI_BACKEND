const router = require('express').Router();
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const orderService = require('../services/order.service');
const locationService = require('../services/location.service');
const chatService = require('../services/chat.service');
const { Order, Complaint, OrderIssue, User, Driver } = require('../models');

router.use(authenticate, requireRoles('CUSTOMER'));

router.get('/me', async (req, res) => {
  ok(res, { user: req.user, customer: req.customer });
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

router.post('/location', async (req, res, next) => {
  try {
    await locationService.updateCustomerLocation(req.customer, req.body);
    ok(res, { updated: true });
  } catch (e) { next(e); }
});

router.post('/orders', async (req, res, next) => {
  try {
    const { pickupLat, pickupLng, destLat, destLng, promoCode, paymentMethod } = req.body;
    const order = await orderService.createOrder({
      customer: req.customer,
      user: req.user,
      pickup: { lat: pickupLat, lng: pickupLng },
      destination: { lat: destLat, lng: destLng },
      promoCode,
      paymentMethod,
      idempotencyKey: req.headers['idempotency-key'],
    });
    ok(res, { order }, {}, 201);
  } catch (e) { next(e); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const orders = await Order.find({ customerId: req.customer._id }).sort({ createdAt: -1 }).limit(50);
    ok(res, { orders });
  } catch (e) { next(e); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    let driverPublic = null;
    if (order.driverId) {
      const d = await Driver.findById(order.driverId).populate('vehicleId');
      const u = d ? await User.findById(d.userId) : null;
      driverPublic = d && u ? {
        id: d._id,
        firstName: u.firstName,
        lastName: u.lastName,
        ratingAvg: d.ratingAvg,
        location: d.location,
        vehicle: d.vehicleId,
      } : null;
    }
    ok(res, { order, driver: driverPublic });
  } catch (e) { next(e); }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    ok(res, { order: await orderService.cancelOrder({ order, user: req.user, role: 'CUSTOMER', reason: req.body.reason }) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/rating', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    ok(res, { rating: await orderService.rateOrder({ order, customer: req.customer, score: req.body.score, comment: req.body.comment }) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/complaints', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const c = await Complaint.create({
      orderId: order._id,
      customerId: req.customer._id,
      driverId: order.driverId,
      category: req.body.category,
      description: req.body.description,
      attachments: req.body.attachments || [],
    });
    ok(res, { complaint: c }, {}, 201);
  } catch (e) { next(e); }
});

router.post('/orders/:id/issues', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const issue = await OrderIssue.create({
      orderId: order._id,
      reporterRole: 'CUSTOMER',
      reporterUserId: req.user._id,
      type: req.body.type,
      description: req.body.description,
    });
    ok(res, { issue }, {}, 201);
  } catch (e) { next(e); }
});

router.get('/orders/:id/messages', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    ok(res, { messages: await chatService.listMessages(order._id) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/messages', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const driver = order.driverId ? await Driver.findById(order.driverId) : null;
    const msg = await chatService.sendMessage({
      orderId: order._id,
      senderUser: req.user,
      receiverUserId: driver ? driver.userId : req.user._id,
      message: req.body.message,
      clientMessageId: req.body.clientMessageId || `${Date.now()}`,
    });
    ok(res, { message: msg }, {}, 201);
  } catch (e) { next(e); }
});

module.exports = router;
