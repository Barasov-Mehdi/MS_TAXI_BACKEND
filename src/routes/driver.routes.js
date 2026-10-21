const router = require('express').Router();
const mongoose = require('mongoose');
const Joi = require('joi');
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const { getSettings } = require('../services/settings.service');
const orderService = require('../services/order.service');
const dispatchService = require('../services/dispatch.service');
const locationService = require('../services/location.service');
const { Order, Vehicle, WalletTransaction, OrderIssue, Customer, User, Driver, TripEarning } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const { publicUser } = require('../services/auth.service');
const chatService = require('../services/chat.service');

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
    // Sifariş başqası üçün verilibsə sürücü həmin şəxsin adı/nömrəsi ilə əlaqə saxlayır.
    const other = obj.passenger && obj.passenger.forOther ? obj.passenger : null;
    return {
      ...obj,
      customerName: (other && other.name) || name,
      customerPhone: (other && other.phone) || u?.phone || '',
      forOther: Boolean(other),
    };
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
  return {
    maxDriverRadius: st.maxDriverRadius,
    defaultDriverRadius: st.defaultDriverRadius,
    // Tətbiq tarifi buradan göstərir (sabit kod yox): admin ayarı dəyişəndə tətbiq də dəyişir
    commission: {
      type: st.tripCommissionType === 'FIXED' ? 'FIXED' : 'PERCENTAGE',
      normal: Number(st.tripCommission ?? 10),
      low: Number(st.lowRatingCommission ?? 15),
      threshold: Number(st.ratingThreshold ?? 3),
      lowInclusive: st.lowRatingInclusive !== false,
    },
  };
}

// DİQQƏT: User sənədi birbaşa qaytarılmır (passwordHash, OTP/reset kodları sızmasın).
router.get('/me', async (req, res, next) => {
  try {
    const lim = await limits();
    const driver = req.driver.toObject();
    // Köhnə sənədlərdə radius admin həddindən böyük ola bilər (məs. 45000 → tətbiqdə "45.0 km"):
    // axtarışda onsuz da maxDriverRadius ilə məhdudlaşır, ona görə tətbiqə real işləyən dəyər qaytarılır.
    if (lim.maxDriverRadius && driver.radiusMeters > lim.maxDriverRadius) driver.radiusMeters = lim.maxDriverRadius;
    ok(res, {
      user: publicUser(req.user),
      driver,
      vehicle: await loadVehicle(req.driver),
      limits: lim,
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
    // Balans çatmırsa sürücü onlayn olub heç vaxt sifariş almazdı (matching LOW_BALANCE ilə atlayır): açıq xəta göstərilir.
    const st = await getSettings();
    if (!st.negativeBalanceAllowed && (req.driver.walletBalanceMinor || 0) < (st.minimumDriverBalance || 0)) {
      throw new AppError(
        'LOW_BALANCE',
        'Balansınız kifayət etmir. Sifariş almaq üçün balansı artırın',
        403,
        { balanceMinor: req.driver.walletBalanceMinor || 0, minimumMinor: st.minimumDriverBalance || 0 }
      );
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

// FCM cihaz tokeni: tətbiq açılanda / token yenilənəndə çağırılır.
// Eyni token başqa sürücüdə qalıbsa (telefonda hesab dəyişib) oradan silinir ki, təklif səhv şəxsə getməsin.
router.post('/device-token', async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (token.length < 20 || token.length > 4096) {
      throw new AppError('VALIDATION_ERROR', 'Invalid token', 400);
    }
    await Driver.updateMany({ fcmToken: token, _id: { $ne: req.driver._id } }, { $set: { fcmToken: null } });
    await Driver.updateOne({ _id: req.driver._id }, { $set: { fcmToken: token, fcmTokenUpdatedAt: new Date() } });
    ok(res, { saved: true });
  } catch (e) { next(e); }
});

router.delete('/device-token', async (req, res, next) => {
  try {
    await Driver.updateOne({ _id: req.driver._id }, { $set: { fcmToken: null } });
    ok(res, { removed: true });
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

    // Statistika qazanc jurnalından (TripEarning) hesablanır: sifariş bazadan silinsə də rəqəmlər itmir.
    const rows = await TripEarning.aggregate([
      { $match: { driverId: req.driver._id, completedAt: { $gte: since } } },
      {
        $group: {
          _id: dayExpr('$completedAt'),
          trips: { $sum: 1 },
          grossMinor: { $sum: '$grossMinor' },
          commissionMinor: { $sum: '$commissionMinor' },
          distanceMeters: { $sum: '$distanceMeters' },
        },
      },
    ]);
    const byDay = new Map(rows.map((r) => [r._id, r]));
    const list = keys.map((date) => {
      const r = byDay.get(date);
      const grossMinor = r?.grossMinor || 0;
      const commissionMinor = r?.commissionMinor || 0;
      return {
        date,
        trips: r?.trips || 0,
        grossMinor,
        commissionMinor,
        netMinor: grossMinor - commissionMinor,
        distanceMeters: r?.distanceMeters || 0,
      };
    });
    ok(res, { timezone: STATS_TZ, today: list[0], days: list });
  } catch (e) { next(e); }
});

// Xəritədə iki bölgə göstərilir:
//  YAŞIL  (hotspot)    — müştəri tələbinin çox olduğu yer. Üç siqnal birləşdirilir:
//     1) tətbiqi indi açıq olan müştərilər (son HOTSPOT_APP_OPEN_MIN dəq. konum göndərib) — çəki 1
//     2) son HOTSPOT_WINDOW_MIN dəqiqədə verilmiş sifarişlərin götürmə nöqtələri — çəki 2
//     3) hələ sürücü gözləyən sifarişlərin götürmə nöqtələri — çəki 4
//  SARI   (returnSpot) — yaxın zamanda səfərlərin BİTDİYİ (varış) yerlər. Müştəri evdən gedibsə,
//     bir müddət sonra geri qayıtmaq üçün taksi çağıracaq: son RETURN_WINDOW_MIN dəqiqədə başlayan/bitən
//     səfərlərin təyinat nöqtələri hüceyrələrə bölünür, ən sıx hüceyrə qaytarılır.
const HOTSPOT_WINDOW_MIN = 30;
const HOTSPOT_APP_OPEN_MIN = 3;
const RETURN_WINDOW_MIN = 180;
const HOTSPOT_SEARCH_M = 10000; // sürücünün ətrafında axtarış radiusu
const HOTSPOT_CLUSTER_M = 250; // bir kümədə: mərkəz nöqtəsindən maksimum məsafə
const HOTSPOT_SEPARATION_M = 450; // iki dairənin mərkəzləri arası minimum məsafə
const HOTSPOT_MAX_ZONES = 3; // hər rəngdən ən çox neçə dairə
const HOTSPOT_MIN_COUNT = 2; // dairənin görünməsi üçün hüceyrədə ən azı bu qədər nöqtə
const HOTSPOT_RADIUS_MIN_M = 150; // dairənin radiusu kümənin ölçüsünə görə seçilir
const HOTSPOT_RADIUS_MAX_M = 300;
const W_APP = 1;
const W_ORDER = 2;
const W_WAITING = 4;

// items: [{ c: [lng, lat], w: çəki }] → ən sıx kümələr (ən çoxu `max` ədəd, xalına görə sıralı).
// Sabit şəbəkə əvəzinə "yaxınlıq" sayılır: hər nöqtənin HOTSPOT_CLUSTER_M daxilindəki qonşuları toplanır.
// Seçilmiş kümənin ətrafındakı (HOTSPOT_SEPARATION_M) nöqtələr atılır ki, dairələr üst-üstə düşməsin.
function pickClusters(items, max = HOTSPOT_MAX_ZONES) {
  let pts = items.filter(({ c }) => c && c.length >= 2 && !(c[0] === 0 && c[1] === 0));
  const out = [];
  while (pts.length && out.length < max) {
    const latRef = pts[0].c[1];
    const kx = 111320 * Math.cos((latRef * Math.PI) / 180);
    const ky = 111320;
    const dist = (p, q) => Math.hypot((p[0] - q[0]) * kx, (p[1] - q[1]) * ky);
    let best = null;
    for (const a of pts) {
      const members = pts.filter((b) => dist(a.c, b.c) <= HOTSPOT_CLUSTER_M);
      const score = members.reduce((s, m) => s + m.w, 0);
      if (!best || score > best.score) best = { members, score };
    }
    if (!best || best.members.length < HOTSPOT_MIN_COUNT) break;
    const n = best.members.length;
    const center = [
      best.members.reduce((s, m) => s + m.c[0], 0) / n,
      best.members.reduce((s, m) => s + m.c[1], 0) / n,
    ];
    const spread = Math.max(...best.members.map((m) => dist(center, m.c)));
    const radiusMeters = Math.round(
      Math.min(HOTSPOT_RADIUS_MAX_M, Math.max(HOTSPOT_RADIUS_MIN_M, spread + 80)),
    );
    out.push({ center, radiusMeters, count: n });
    pts = pts.filter((p) => dist(p.c, center) > HOTSPOT_SEPARATION_M);
  }
  return out;
}

router.get('/hotspot', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return next(new AppError('VALIDATION_ERROR', 'lat/lng düzgün deyil', 400));
    }
    const geo = { $geoWithin: { $centerSphere: [[lng, lat], HOTSPOT_SEARCH_M / 6371000] } };
    const now = Date.now();
    const returnSince = new Date(now - RETURN_WINDOW_MIN * 60000);
    const [orders, openCustomers, tripOrders] = await Promise.all([
      Order.find({
        createdAt: { $gte: new Date(now - HOTSPOT_WINDOW_MIN * 60000) },
        status: { $nin: [OrderStatus.ADMIN_CANCELLED] },
        pickup: geo,
      }).select('pickup status').limit(1000).lean(),
      Customer.find({
        locationUpdatedAt: { $gte: new Date(now - HOTSPOT_APP_OPEN_MIN * 60000) },
        location: geo,
      }).select('location').limit(1000).lean(),
      Order.find({
        status: {
          $in: [OrderStatus.TRIP_STARTED, OrderStatus.TRIP_COMPLETED, OrderStatus.RATING_PENDING, OrderStatus.COMPLETED],
        },
        $or: [{ completedAt: { $gte: returnSince } }, { startedAt: { $gte: returnSince } }],
        destination: geo,
      }).select('destination').limit(1000).lean(),
    ]);

    const demand = [
      ...orders.map((o) => ({ c: o.pickup?.coordinates, w: o.status === OrderStatus.SEARCHING_DRIVER ? W_WAITING : W_ORDER })),
      ...openCustomers.map((c) => ({ c: c.location?.coordinates, w: W_APP })),
    ];
    const arrivals = tripOrders.map((o) => ({ c: o.destination?.coordinates, w: 1 }));

    const hotspots = pickClusters(demand);
    const returnSpots = pickClusters(arrivals);
    // hotspot/returnSpot: köhnə tətbiqlərlə uyğunluq (ən sıx bölgə)
    const out = { hotspots, returnSpots, hotspot: hotspots[0] || null, returnSpot: returnSpots[0] || null };
    // Yoxlama üçün: /drivers/hotspot?lat=..&lng=..&debug=1 → neçə nöqtə tapıldığını göstərir (şəxsi məlumat yoxdur)
    if (req.query.debug === '1') out.debug = { orders: orders.length, openCustomers: openCustomers.length, arrivals: arrivals.length, greenZones: hotspots.length, yellowZones: returnSpots.length };
    ok(res, out);
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

// Tətbiq yenidən açılanda: davam edən sifariş (sərnişin adı/nömrəsi ilə) və növbədəki sifarişlər.
// Qeyd: '/orders/:id'-dən əvvəl təyin olunmalıdır.
router.get('/orders/active', async (req, res, next) => {
  try {
    const driver = await Driver.findById(req.driver._id).lean();
    const current = driver.currentOrderId ? await Order.findById(driver.currentOrderId) : null;
    const queuedIds = driver.queuedOrderIds || [];
    const queued = queuedIds.length ? await Order.find({ _id: { $in: queuedIds } }) : [];
    ok(res, {
      order: current ? await withCustomers(current) : null,
      queued: await withCustomers(queued),
    });
  } catch (e) { next(e); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, driverId: req.driver._id });
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    ok(res, { order: await withCustomers(order) });
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