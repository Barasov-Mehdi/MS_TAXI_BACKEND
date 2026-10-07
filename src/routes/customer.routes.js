const router = require('express').Router();
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const orderService = require('../services/order.service');
const authService = require('../services/auth.service');
const { parseUsername } = require('../utils/validators');
const pricingService = require('../services/pricing.service');
const locationService = require('../services/location.service');
const chatService = require('../services/chat.service');
const { Order, Complaint, OrderIssue, User, Driver } = require('../models');

router.use(authenticate, requireRoles('CUSTOMER'));

router.get('/me', async (req, res) => {
  ok(res, { user: authService.publicUser(req.user), customer: req.customer });
});

// Ad, soyad, istifadəçi adı və email sonradan əlavə oluna bilər. İstifadəçi adı boş qala bilməz.
router.patch('/me', async (req, res, next) => {
  try {
    const { firstName, lastName, username, email } = req.body;
    const user = req.user;

    if (firstName != null) user.firstName = String(firstName).trim().slice(0, 50);
    if (lastName != null) user.lastName = String(lastName).trim().slice(0, 50);

    if (username !== undefined) {
      const parsed = parseUsername(username);
      if (!parsed) {
        throw new AppError(
          'INVALID_USERNAME',
          'İstifadəçi adı 3–20 simvol olmalıdır (hərf, rəqəm, nöqtə, alt xətt)',
          400
        );
      }
      const taken = await User.findOne({ usernameLower: parsed.usernameLower, _id: { $ne: user._id } });
      if (taken) throw new AppError('USERNAME_TAKEN', 'Bu istifadəçi adı artıq tutulub', 409);
      user.username = parsed.username;
      user.usernameLower = parsed.usernameLower;
    }

    if (email !== undefined) {
      const value = String(email || '').trim().toLowerCase();
      if (value) {
        if (value.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          throw new AppError('INVALID_EMAIL', 'Email düzgün deyil', 400);
        }
        const used = await User.findOne({ email: value, _id: { $ne: user._id } });
        if (used) throw new AppError('EMAIL_TAKEN', 'Bu email artıq istifadə olunur', 409);
        user.email = value;
      } else {
        user.email = null;
      }
    }

    try {
      await user.save();
    } catch (e) {
      if (e && e.code === 11000) throw new AppError('USERNAME_TAKEN', 'Bu istifadəçi adı artıq tutulub', 409);
      throw e;
    }
    ok(res, { user: authService.publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/location', async (req, res, next) => {
  try {
    await locationService.updateCustomerLocation(req.customer, req.body);
    ok(res, { updated: true });
  } catch (e) { next(e); }
});

const toPoint = (p) => {
  const lat = Number(p && p.lat);
  const lng = Number(p && p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new AppError('INVALID_POINTS', 'Invalid coordinates', 400);
  }
  return { lat, lng, label: p.label, address: p.address };
};

/** Yeni format: { pickup, stops[] }; köhnə format: pickupLat/pickupLng/destLat/destLng. */
function parseTrip(body) {
  const pickup = toPoint(body.pickup || { lat: body.pickupLat, lng: body.pickupLng });
  let rawStops = [];
  if (Array.isArray(body.stops) && body.stops.length) rawStops = body.stops;
  else if (body.dropoff) rawStops = [body.dropoff];
  else rawStops = [{ lat: body.destLat, lng: body.destLng }];
  if (rawStops.length > 4) throw new AppError('TOO_MANY_STOPS', 'At most 4 stops', 400);
  const stops = rawStops.map(toPoint);
  return { pickup, stops, destination: stops[stops.length - 1] };
}

// Sifarişdən əvvəl qiymət: DB-dəki aktiv tarifdən (admin dəyişə bilər) hesablanır.
router.post('/orders/quote', async (req, res, next) => {
  try {
    const { pickup, stops } = parseTrip(req.body);
    const requested = Array.isArray(req.body.vehicleTypes) && req.body.vehicleTypes.length
      ? req.body.vehicleTypes
      : pricingService.VEHICLE_TYPES;
    const types = requested.filter((t) => pricingService.VEHICLE_TYPES.includes(t));
    const metrics = pricingService.resolveTripMetrics({
      points: [pickup, ...stops],
      distanceMeters: req.body.distanceMeters,
      durationMin: req.body.durationMin,
    });
    const quotes = {};
    for (const vehicleType of types) {
      const q = await pricingService.calculateTripPrice({
        ...metrics,
        stopCount: stops.length - 1,
        vehicleType,
      });
      quotes[vehicleType] = {
        priceMinor: q.finalPriceMinor,
        price: q.finalPriceMinor / 100,
        surgeMultiplier: q.surgeMultiplier,
      };
    }
    ok(res, { quotes, ...metrics, currency: 'AZN' });
  } catch (e) { next(e); }
});

router.post('/orders', async (req, res, next) => {
  try {
    const { promoCode } = req.body;
    const paymentMethod = req.body.paymentMethod
      ? String(req.body.paymentMethod).toUpperCase()
      : req.body.payment
      ? String(req.body.payment).toUpperCase()
      : undefined;
    const { pickup, stops, destination } = parseTrip(req.body);
    const order = await orderService.createOrder({
      customer: req.customer,
      user: req.user,
      pickup,
      destination,
      stops,
      vehicleType: req.body.vehicleType || 'basic',
      distanceMeters: req.body.distanceMeters,
      durationMin: req.body.durationMin,
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
