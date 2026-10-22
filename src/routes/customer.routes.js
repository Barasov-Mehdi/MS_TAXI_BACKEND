const router = require('express').Router();
const mongoose = require('mongoose');
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const orderService = require('../services/order.service');
const authService = require('../services/auth.service');
const { parseUsername } = require('../utils/validators');
const pricingService = require('../services/pricing.service');
const locationService = require('../services/location.service');
const chatService = require('../services/chat.service');
const { Order, Complaint, OrderIssue, User, Driver, Rating } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const adminFeed = require('../websocket/adminFeed');
const Joi = require('joi');
const promoService = require('../services/promo.service');
const cityService = require('../services/city.service');

function validated(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { stripUnknown: true });
    if (error) return next(new AppError('VALIDATION_ERROR', error.details[0].message, 400));
    req.body = value;
    next();
  };
}

const COMPLAINT_CATEGORIES = ['DRIVER_BEHAVIOR', 'VEHICLE_PROBLEM', 'PAYMENT', 'WRONG_ROUTE', 'SAFETY', 'OTHER'];

router.use(authenticate, requireRoles('CUSTOMER'));

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return next(new AppError('ORDER_NOT_FOUND', 'Sifariş tapılmadı', 404));
  }
  return next();
});

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
    // Cavab müştərinin istədiyi adla qaytarılır (köhnə tətbiq köhnə adla soruşsa da işləsin)
    const types = requested.filter((t) => pricingService.VEHICLE_TYPES.includes(pricingService.normalizeVehicleType(t)));
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
        vehicleType: pricingService.normalizeVehicleType(vehicleType),
      });
      quotes[vehicleType] = {
        priceMinor: q.finalPriceMinor,
        price: q.finalPriceMinor / 100,
        surgeMultiplier: q.surgeMultiplier,
      };
    }

    // Promo kod: hər sinif üçün endirimli qiymət (sifariş yaradılanda eyni qayda tətbiq olunur)
    let promo = null;
    const code = req.body.promoCode ? String(req.body.promoCode).trim().toUpperCase() : '';
    if (code) {
      promo = { code, valid: false, error: null };
      for (const t of Object.keys(quotes)) {
        try {
          const r = await promoService.validateAndQuote(code, req.customer._id, quotes[t].priceMinor, req.user._id);
          const discount = Math.min(r.discountMinor || 0, quotes[t].priceMinor);
          quotes[t].originalPriceMinor = quotes[t].priceMinor;
          quotes[t].discountMinor = discount;
          quotes[t].priceMinor -= discount;
          quotes[t].price = quotes[t].priceMinor / 100;
          promo.valid = true;
        } catch (e) {
          // Bir sinif üçün uyğun olmaya bilər (məs. minimum məbləğ) - digərləri üçün işləyə bilər
          if (!promo.error) promo.error = { code: e.code || 'PROMO_INVALID', message: e.message };
        }
      }
      if (promo.valid) promo.error = null;
    }
    ok(res, { quotes, promo, ...metrics, currency: 'AZN' });
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
      passenger: req.body.passenger,
      idempotencyKey: req.headers['idempotency-key'],
    });
    ok(res, { order }, {}, 201);
  } catch (e) { next(e); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const rows = await Order.find({ customerId: req.customer._id }).sort({ createdAt: -1 }).limit(50);

    // Tarixçə üçün: hər sifarişə sürücü məlumatı və müştərinin verdiyi ulduz əlavə olunur.
    const driverIds = [...new Set(rows.map((o) => o.driverId && String(o.driverId)).filter(Boolean))];
    const drivers = driverIds.length
      ? await Driver.find({ _id: { $in: driverIds } }).populate('vehicleId')
      : [];
    const users = drivers.length
      ? await User.find({ _id: { $in: drivers.map((d) => d.userId) } })
      : [];
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const driverById = new Map();
    drivers.forEach((d) => {
      const u = userById.get(String(d.userId));
      driverById.set(String(d._id), {
        id: d._id,
        firstName: u && u.firstName,
        lastName: u && u.lastName,
        phone: u && u.phone,
        ratingAvg: d.ratingAvg,
        ratingCount: d.ratingCount,
        vehicle: d.vehicleId
          ? {
            make: d.vehicleId.make,
            model: d.vehicleId.model,
            color: d.vehicleId.color,
            plateNumber: d.vehicleId.plateNumber,
          }
          : null,
      });
    });
    const ratings = await Rating.find({ orderId: { $in: rows.map((o) => o._id) } }).select('orderId score');
    const scoreByOrder = new Map(ratings.map((r) => [String(r.orderId), r.score]));
    const complaints = await Complaint.find({ orderId: { $in: rows.map((o) => o._id) } })
      .sort({ createdAt: -1 })
      .select('orderId status category createdAt')
      .lean();
    const complaintByOrder = new Map();
    complaints.forEach((c) => {
      if (!complaintByOrder.has(String(c.orderId))) complaintByOrder.set(String(c.orderId), { status: c.status, category: c.category, createdAt: c.createdAt });
    });

    const orders = rows.map((o) => ({
      ...o.toObject(),
      driver: o.driverId ? driverById.get(String(o.driverId)) || null : null,
      myRating: scoreByOrder.get(String(o._id)) || null,
      complaint: complaintByOrder.get(String(o._id)) || null,
    }));
    ok(res, { orders });
  } catch (e) { next(e); }
});

async function publicDriver(order) {
  if (!order || !order.driverId) return null;
  const d = await Driver.findById(order.driverId).populate('vehicleId');
  const u = d ? await User.findById(d.userId) : null;
  return d && u ? {
    id: d._id,
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    ratingAvg: d.ratingAvg,
    location: d.location,
    vehicle: d.vehicleId,
  } : null;
}

// Aktiv sifariş. Aktiv səfər yoxdursa, sürücüyə hələ ulduz verilməmiş bitmiş səfər
// { awaitingRating: true } ilə qaytarılır (CustomerHome-da "qiymətləndir" kartı üçün).
// Qeyd: '/orders/:id'-dən əvvəl təyin olunmalıdır.
router.get('/orders/active', async (req, res, next) => {
  try {
    const waiting = [OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING];
    const inactive = [
      OrderStatus.COMPLETED,
      OrderStatus.CUSTOMER_CANCELLED,
      OrderStatus.DRIVER_CANCELLED,
      OrderStatus.ADMIN_CANCELLED,
      OrderStatus.EXPIRED,
    ];
    const live = await Order.findOne({
      customerId: req.customer._id,
      status: { $nin: [...inactive, ...waiting] },
    }).sort({ createdAt: -1 });
    if (live) {
      return ok(res, { order: live, driver: await publicDriver(live), awaitingRating: false });
    }

    const pending = await Order.findOne({
      customerId: req.customer._id,
      status: { $in: waiting },
      driverId: { $ne: null },
    }).sort({ completedAt: -1, createdAt: -1 });
    if (pending && !pending.ratingId && !(await Rating.exists({ orderId: pending._id }))) {
      return ok(res, { order: pending, driver: await publicDriver(pending), awaitingRating: true });
    }
    return ok(res, { order: null, driver: null, awaitingRating: false });
  } catch (e) { next(e); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const driverPublic = await publicDriver(order);
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

router.post(
  '/orders/:id/complaints',
  validated(Joi.object({
    category: Joi.string().valid(...COMPLAINT_CATEGORIES).required().messages({ 'any.only': 'Mövzunu seçin', 'any.required': 'Mövzunu seçin' }),
    description: Joi.string().trim().min(5).max(1000).required().messages({
      'string.empty': 'Nə baş verdiyini yazın',
      'string.min': 'Bir az ətraflı yazın (ən azı 5 simvol)',
      'any.required': 'Nə baş verdiyini yazın',
    }),
    attachments: Joi.array().items(Joi.string().max(500)).max(5),
  })),
  async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.customer._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Sifariş tapılmadı', 404);
    const open = await Complaint.findOne({ orderId: order._id, status: { $nin: ['RESOLVED', 'REJECTED'] } });
    if (open) throw new AppError('COMPLAINT_EXISTS', 'Bu səfər üzrə şikayətiniz artıq baxılır', 409);
    const c = await Complaint.create({
      orderId: order._id,
      customerId: req.customer._id,
      driverId: order.driverId,
      category: req.body.category,
      description: req.body.description,
      attachments: req.body.attachments || [],
    });
    adminFeed.feedback({ order, complaint: { _id: c._id, category: c.category } });
    ok(res, { complaint: c }, {}, 201);
  } catch (e) { next(e); }
  }
);

// FCM cihaz tokeni: tətbiq açılanda / token yenilənəndə göndərilir (push bildirişləri üçün)
router.post(
  '/fcm-token',
  validated(Joi.object({ token: Joi.string().trim().min(20).max(4096).required() })),
  async (req, res, next) => {
    try {
      const { Customer } = require('../models');
      // Eyni cihaz başqa hesabla açılıbsa köhnə hesabdan token götürülür (bildiriş səhv adama getməsin)
      await Customer.updateMany({ fcmToken: req.body.token, _id: { $ne: req.customer._id } }, { $set: { fcmToken: null } });
      await Customer.updateOne({ _id: req.customer._id }, { $set: { fcmToken: req.body.token, fcmTokenUpdatedAt: new Date() } });
      ok(res, { saved: true });
    } catch (e) { next(e); }
  }
);

router.delete('/fcm-token', async (req, res, next) => {
  try {
    const { Customer } = require('../models');
    await Customer.updateOne({ _id: req.customer._id }, { $set: { fcmToken: null } });
    ok(res, { removed: true });
  } catch (e) { next(e); }
});

// Müştəri üçün ofis (dəstək) məlumatı: mövqeyə ən yaxın şəhərin ofisi + bütün ofislər
router.get('/office', async (req, res, next) => {
  try {
    const all = await cityService.listActive();
    const near = await cityService.cityForPoint(req.query.lat, req.query.lng);
    const nearest = near ? all.find((c) => String(c._id) === String(near.id)) || null : null;
    ok(res, { nearest, cities: all.filter((c) => c.officePhone) });
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
    adminFeed.issue(issue);
    ok(res, { issue }, {}, 201);
  } catch (e) { next(e); }
});

router.get('/orders/:id/messages', async (req, res, next) => {
  try {
    ok(res, { messages: await chatService.listMessages(req.params.id, req.user) });
  } catch (e) { next(e); }
});

router.post('/orders/:id/messages', async (req, res, next) => {
  try {
    const msg = await chatService.sendMessage({
      orderId: req.params.id,
      senderUser: req.user,
      message: req.body.message,
      clientMessageId: req.body.clientMessageId,
    });
    ok(res, { message: msg }, {}, 201);
  } catch (e) { next(e); }
});

module.exports = router;