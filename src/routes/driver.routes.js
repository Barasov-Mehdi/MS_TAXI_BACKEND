const router = require('express').Router();
const mongoose = require('mongoose');
const Joi = require('joi');
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const { getSettings } = require('../services/settings.service');
const orderService = require('../services/order.service');
const dispatchService = require('../services/dispatch.service');
const locationService = require('../services/location.service');
const { Order, Vehicle, WalletTransaction, OrderIssue, Customer, User } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const { publicUser } = require('../services/auth.service');

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

function validated(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { stripUnknown: true });
    if (error) return next(new AppError('VALIDATION_ERROR', error.details[0].message, 400));
    req.body = value;
    next();
  };
}

async function loadVehicle(driver) {
  return driver.vehicleId ? Vehicle.findById(driver.vehicleId).lean() : null;
}

// Tətbiqin ehtiyac duyduğu limitlər (radius yuxarı həddi və s.)
async function limits() {
  const st = await getSettings();
  return { maxDriverRadius: st.maxDriverRadius, defaultDriverRadius: st.defaultDriverRadius };
}

// DİQQƏT: User sənədi birbaşa qaytarılmır (passwordHash, OTP/reset kodları sızmasın).
router.get('/me', async (req, res, next) => {
  try {
    ok(res, {
      user: publicUser(req.user),
      driver: req.driver,
      vehicle: await loadVehicle(req.driver),
      limits: await limits(),
    });
  } catch (e) { next(e); }
});

const nameField = Joi.string().trim().min(1).max(50).messages({
  'string.empty': 'Ad boş ola bilməz',
  'string.max': 'Ən çox 50 simvol',
});

router.patch(
  '/me',
  validated(Joi.object({
    firstName: nameField,
    lastName: nameField,
    email: Joi.string().trim().lowercase().email().allow('', null).messages({ 'string.email': 'E-poçt düzgün deyil' }),
  })),
  async (req, res, next) => {
    try {
      const { firstName, lastName, email } = req.body;
      if (firstName !== undefined) req.user.firstName = firstName;
      if (lastName !== undefined) req.user.lastName = lastName;
      if (email !== undefined) {
        const next_ = email || null;
        if (next_ && (await User.exists({ email: next_, _id: { $ne: req.user._id } }))) {
          throw new AppError('EMAIL_TAKEN', 'Bu e-poçt artıq istifadə olunur', 409);
        }
        req.user.email = next_;
      }
      await req.user.save();
      ok(res, { user: publicUser(req.user) });
    } catch (e) { next(e); }
  }
);

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
    const r = Math.round(Number(req.body.radiusMeters));
    if (!r || r < 500 || r > settings.maxDriverRadius) {
      throw new AppError('INVALID_RADIUS', `Radius 500 m ilə ${settings.maxDriverRadius} m arasında olmalıdır`, 400);
    }
    req.driver.radiusMeters = r;
    await req.driver.save();
    ok(res, { radiusMeters: req.driver.radiusMeters });
  } catch (e) { next(e); }
});

const vehicleSchema = Joi.object({
  make: Joi.string().trim().min(1).max(40).required().messages({ 'any.required': 'Markanı yazın', 'string.empty': 'Markanı yazın' }),
  model: Joi.string().trim().min(1).max(40).required().messages({ 'any.required': 'Modeli yazın', 'string.empty': 'Modeli yazın' }),
  color: Joi.string().trim().min(1).max(30).required().messages({ 'any.required': 'Rəngi yazın', 'string.empty': 'Rəngi yazın' }),
  plateNumber: Joi.string().trim().min(4).max(12).required().messages({
    'any.required': 'Nömrə nişanını yazın',
    'string.empty': 'Nömrə nişanını yazın',
    'string.min': 'Nömrə nişanı düzgün deyil',
  }),
  year: Joi.number().integer().min(1980).max(new Date().getFullYear() + 1).allow(null).messages({
    'number.min': 'İl düzgün deyil',
    'number.max': 'İl düzgün deyil',
    'number.base': 'İl düzgün deyil',
  }),
  seats: Joi.number().integer().min(1).max(8),
});

router.get('/vehicle', async (req, res, next) => {
  try {
    ok(res, { vehicle: await loadVehicle(req.driver) });
  } catch (e) { next(e); }
});

// Avtomobil yoxdursa yaradır, varsa YENİLƏYİR (təkrar sənəd yaranmır). Yalnız icazə verilən sahələr qəbul olunur.
async function saveVehicle(req, res, next) {
  try {
    if (req.driver.currentOrderId) {
      throw new AppError('ACTIVE_TRIP', 'Aktiv sifariş zamanı avtomobili dəyişmək olmaz', 409);
    }
    const data = { ...req.body, plateNumber: req.body.plateNumber.replace(/[\s]+/g, '').toUpperCase() };
    let vehicle = req.driver.vehicleId ? await Vehicle.findById(req.driver.vehicleId) : null;
    const created = !vehicle;
    try {
      if (vehicle) {
        vehicle.set(data);
        await vehicle.save();
      } else {
        vehicle = await Vehicle.create({ ...data, driverId: req.driver._id });
        req.driver.vehicleId = vehicle._id;
        await req.driver.save();
      }
    } catch (e) {
      if (e && e.code === 11000) throw new AppError('PLATE_TAKEN', 'Bu nömrə nişanı artıq qeydiyyatdadır', 409);
      throw e;
    }
    ok(res, { vehicle }, {}, created ? 201 : 200);
  } catch (e) { next(e); }
}
router.put('/vehicle', validated(vehicleSchema), saveVehicle);
router.post('/vehicle', validated(vehicleSchema), saveVehicle); // köhnə tətbiqlərlə uyğunluq

router.get('/orders', async (req, res, next) => {
  try {
    const rows = await Order.find({ driverId: req.driver._id }).sort({ createdAt: -1 }).limit(50);
    ok(res, { orders: await withCustomers(rows) });
  } catch (e) { next(e); }
});

// Gündəlik statistika: hər gün üçün tamamlanan sifariş sayı və qazanc (son N gün, bugünkü daxil).
// gross = sərnişindən tutulan məbləğ, commission = balansdan çıxılan komissiya, net = gross - commission.
const STATS_TZ = process.env.STATS_TIMEZONE || 'Asia/Baku';
const DONE = [OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING, OrderStatus.COMPLETED];

function dayKey(date) {
  // en-CA → YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: STATS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

router.get('/stats', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 31);
    // Aralığın başlanğıcı: (days) gün əvvəl, bir az geniş götürülür, sonra açarlara görə süzülür.
    const keys = [];
    for (let i = 0; i < days; i++) keys.push(dayKey(new Date(Date.now() - i * 86400000)));
    const since = new Date(Date.now() - (days + 1) * 86400000);
    const dayExpr = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: STATS_TZ } });

    const [orderRows, commRows] = await Promise.all([
      Order.aggregate([
        { $match: { driverId: req.driver._id, status: { $in: DONE }, completedAt: { $gte: since } } },
        { $group: { _id: dayExpr('$completedAt'), trips: { $sum: 1 }, grossMinor: { $sum: { $ifNull: ['$pricingSnapshot.finalPriceMinor', 0] } } } },
      ]),
      WalletTransaction.aggregate([
        { $match: { driverId: req.driver._id, type: 'TRIP_COMMISSION', createdAt: { $gte: since } } },
        { $group: { _id: dayExpr('$createdAt'), commissionMinor: { $sum: { $abs: '$amountMinor' } } } },
      ]),
    ]);
    const o = new Map(orderRows.map((r) => [r._id, r]));
    const c = new Map(commRows.map((r) => [r._id, r]));
    const list = keys.map((date) => {
      const trips = o.get(date)?.trips || 0;
      const grossMinor = o.get(date)?.grossMinor || 0;
      const commissionMinor = c.get(date)?.commissionMinor || 0;
      return { date, trips, grossMinor, commissionMinor, netMinor: grossMinor - commissionMinor };
    });
    ok(res, { timezone: STATS_TZ, today: list[0], days: list });
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