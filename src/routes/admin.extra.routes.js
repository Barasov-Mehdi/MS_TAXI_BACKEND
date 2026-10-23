/**
 * Admin paneli — əlavə bölmələr:
 *  sənədlər, sifarişə sürücü təyini (namizədlər), sərnişinlər, canlı xəritə, hesabatlar,
 *  sürücü məlumatının düzəlişi, əməliyyat jurnalı.
 * Səlahiyyət qaydaları admin.routes.js ilə eynidir (middleware/adminScope.js).
 */
const router = require('express').Router();
const Joi = require('joi');
const { authenticate, requireRoles } = require('../middleware/auth');
const {
  scopeOf, driverFilter, loadDriverInScope, scopedDriverIds, loadOrderInScope, scopedOrderFilter,
} = require('../middleware/adminScope');
const { ok, AppError } = require('../utils/errors');
const { normalizePhone } = require('../utils/validators');
const views = require('../services/adminViews.service');
const documentService = require('../services/document.service');
const pushService = require('../services/push.service');
const cityService = require('../services/city.service');
const realtime = require('../websocket/emitter');
const adminFeed = require('../websocket/adminFeed');
const {
  Order, Driver, Customer, User, Vehicle, Rating, Complaint, TripEarning, AuditLog, DriverDocument, City, RefreshToken,
} = require('../models');

// admin.routes.js içində qoşulur: orada artıq yoxlanıbsa təkrar DB sorğusu edilmir
router.use((req, res, next) => (req.user ? next() : authenticate(req, res, next)), requireRoles('ADMIN'));

const audit = (req, action, entityType, entityId, oldValue, newValue, reason) =>
  AuditLog.create({ actorId: req.user._id, actorRole: 'ADMIN', action, entityType, entityId, oldValue, newValue, reason, ip: req.ip });

function validated(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body || {}, { stripUnknown: true });
    if (error) return next(new AppError('VALIDATION_ERROR', error.details[0].message, 400));
    req.body = value;
    next();
  };
}

const escRx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// =============================================================== 1. Sürücü sənədləri

router.get('/drivers/:id/documents', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id, { allowDeleted: true });
    ok(res, await documentService.listForDriver(driver._id));
  } catch (e) { next(e); }
});

async function loadDocInScope(req, docId) {
  const doc = await DriverDocument.findById(views.oid(docId));
  if (!doc) throw new AppError('NOT_FOUND', 'Sənəd tapılmadı', 404);
  await loadDriverInScope(req, doc.driverId, { allowDeleted: true });
  return doc;
}

/** Şəkil faylı (panel Authorization başlığı ilə yükləyir). */
router.get('/documents/:docId/file', async (req, res, next) => {
  try {
    await documentService.streamFile(await loadDocInScope(req, req.params.docId), res);
  } catch (e) { next(e); }
});

router.post('/documents/:docId/approve', async (req, res, next) => {
  try {
    const doc = await loadDocInScope(req, req.params.docId);
    await documentService.review(doc._id, req.user, { approve: true });
    await audit(req, 'DOCUMENT_APPROVE', 'Driver', doc.driverId, null, { type: doc.type });
    pushService.notifyDocument(doc.driverId, { label: documentService.LABELS[doc.type], approved: true }).catch(() => {});
    realtime.toDriver(doc.driverId, 'documents_updated', {});
    ok(res, await documentService.listForDriver(doc.driverId));
  } catch (e) { next(e); }
});

router.post(
  '/documents/:docId/reject',
  validated(Joi.object({ reason: Joi.string().trim().min(2).max(300).required().messages({ 'any.required': 'Səbəbi yazın', 'string.empty': 'Səbəbi yazın' }) })),
  async (req, res, next) => {
    try {
      const doc = await loadDocInScope(req, req.params.docId);
      await documentService.review(doc._id, req.user, { approve: false, reason: req.body.reason });
      await audit(req, 'DOCUMENT_REJECT', 'Driver', doc.driverId, null, { type: doc.type }, req.body.reason);
      pushService
        .notifyDocument(doc.driverId, { label: documentService.LABELS[doc.type], approved: false, reason: req.body.reason })
        .catch(() => {});
      realtime.toDriver(doc.driverId, 'documents_updated', {});
      ok(res, await documentService.listForDriver(doc.driverId));
    } catch (e) { next(e); }
  }
);

/** Yoxlama növbəsi: yoxlanmamış (PENDING) sənədi olan sürücülər. */
router.get('/documents/queue', async (req, res, next) => {
  try {
    const ids = await scopedDriverIds(req);
    const rows = await DriverDocument.aggregate([
      { $match: { status: 'PENDING', ...(ids ? { driverId: { $in: ids } } : {}) } },
      { $group: { _id: '$driverId', pending: { $sum: 1 }, lastAt: { $max: '$updatedAt' } } },
      { $sort: { lastAt: -1 } },
      { $limit: 200 },
    ]);
    const info = await views.driverInfoMap(rows.map((r) => r._id));
    ok(res, {
      drivers: rows
        .map((r) => ({ ...info.get(String(r._id)), _id: r._id, pending: r.pending, lastAt: r.lastAt }))
        .filter((d) => !d.deleted),
    });
  } catch (e) { next(e); }
});

// =============================================================== 3. Sifarişə sürücü təyini

/** Sifariş üçün uyğun sürücülər: əvvəl boş + onlayn, götürmə nöqtəsinə yaxınlığa görə. */
router.get('/orders/:id/candidates', async (req, res, next) => {
  try {
    const order = await loadOrderInScope(req, req.params.id);
    const [lng, lat] = order.pickup.coordinates;
    const q = driverFilter(req, { deletedAt: null, isActive: true, isVerified: true });
    // Baş admin üçün: sifarişin şəhəri məlumdursa həmin şəhərin sürücüləri
    if (scopeOf(req).isSuper && order.cityId && !req.query.all) q.cityId = order.cityId;
    if (req.query.q) {
      const rx = new RegExp(escRx(String(req.query.q).trim().slice(0, 40)), 'i');
      const [users, vehicles] = await Promise.all([
        User.find({ role: 'DRIVER', $or: [{ firstName: rx }, { lastName: rx }, { phone: rx }] }).distinct('_id'),
        Vehicle.find({ plateNumber: rx }).distinct('driverId'),
      ]);
      q.$or = [{ userId: { $in: users } }, { _id: { $in: vehicles } }];
    }
    const docs = await Driver.find(q)
      .select('location isOnline currentOrderId walletBalanceMinor ratingAvg locationUpdatedAt')
      .limit(400)
      .lean();
    const info = await views.driverInfoMap(docs.map((d) => d._id));
    const list = docs
      .map((d) => {
        const c = d.location && d.location.coordinates;
        const has = c && (c[0] !== 0 || c[1] !== 0);
        return {
          ...info.get(String(d._id)),
          _id: d._id,
          isOnline: d.isOnline,
          busy: !!d.currentOrderId && String(d.currentOrderId) !== String(order._id),
          walletBalanceMinor: d.walletBalanceMinor,
          distanceKm: has ? Math.round(cityService.distKm(lat, lng, c[1], c[0]) * 10) / 10 : null,
          locationUpdatedAt: d.locationUpdatedAt,
        };
      })
      .sort((a, b) => {
        const rank = (x) => (x.isOnline && !x.busy ? 0 : x.isOnline ? 1 : 2);
        return rank(a) - rank(b) || (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999);
      })
      .slice(0, 60);
    ok(res, { candidates: list, order: { _id: order._id, status: order.status, driverId: order.driverId } });
  } catch (e) { next(e); }
});

// =============================================================== 4. Sərnişinlər

/** Regional admin üçün: öz şəhərində sifarişi olan müştərilər. */
async function scopedCustomerIds(req) {
  const scope = await scopedOrderFilter(req);
  if (!scope) return null;
  return Order.find(scope).distinct('customerId');
}

router.get('/customers', async (req, res, next) => {
  try {
    const { skip, limit, page } = views.paging(req.query, 30);
    const q = {};
    const scoped = await scopedCustomerIds(req);
    if (scoped) q._id = { $in: scoped };
    if (req.query.q || req.query.status) {
      const uq = { role: 'CUSTOMER' };
      if (req.query.q) {
        const text = String(req.query.q).trim().slice(0, 50);
        const rx = new RegExp(escRx(text), 'i');
        const phone = normalizePhone(text);
        uq.$or = [{ firstName: rx }, { lastName: rx }, { username: rx }, { phone: rx }, ...(phone ? [{ phone }] : [])];
      }
      if (req.query.status === 'blocked') uq.isActive = false;
      if (req.query.status === 'active') uq.isActive = true;
      q.userId = { $in: await User.find(uq).distinct('_id') };
    }
    const [docs, total] = await Promise.all([
      Customer.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('userId', 'firstName lastName username phone isActive createdAt').lean(),
      Customer.countDocuments(q),
    ]);
    const ids = docs.map((c) => c._id);
    const counts = await Order.aggregate([
      { $match: { customerId: { $in: ids } } },
      {
        $group: {
          _id: '$customerId',
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'TRIP_COMPLETED', 'RATING_PENDING']] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CUSTOMER_CANCELLED'] }, 1, 0] } },
          lastAt: { $max: '$createdAt' },
        },
      },
    ]);
    const by = new Map(counts.map((c) => [String(c._id), c]));
    ok(res, {
      customers: docs.map((c) => {
        const u = c.userId || {};
        const n = by.get(String(c._id)) || {};
        return {
          _id: c._id,
          userId: u._id,
          name: views.displayName(u),
          phone: u.phone || '',
          isActive: u.isActive !== false,
          createdAt: c.createdAt,
          orders: n.total || 0,
          completed: n.completed || 0,
          cancelled: n.cancelled || 0,
          lastOrderAt: n.lastAt || null,
        };
      }),
      total,
      page,
      limit,
    });
  } catch (e) { next(e); }
});

async function loadCustomerInScope(req, id) {
  const c = await Customer.findById(views.oid(id)).populate('userId');
  if (!c) throw new AppError('NOT_FOUND', 'Müştəri tapılmadı', 404);
  const scope = await scopedOrderFilter(req);
  if (scope && !(await Order.exists({ $and: [{ customerId: c._id }, scope] }))) {
    throw new AppError('NOT_FOUND', 'Müştəri tapılmadı', 404);
  }
  return c;
}

router.get('/customers/:id', async (req, res, next) => {
  try {
    const c = await loadCustomerInScope(req, req.params.id);
    const u = c.userId || {};
    const scope = await scopedOrderFilter(req);
    const oq = scope ? { $and: [{ customerId: c._id }, scope] } : { customerId: c._id };
    const [orders, totals, ratings, complaints] = await Promise.all([
      Order.find(oq).sort({ createdAt: -1 }).limit(30).lean(),
      Order.aggregate([
        { $match: { customerId: c._id } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'TRIP_COMPLETED', 'RATING_PENDING']] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CUSTOMER_CANCELLED'] }, 1, 0] } },
            spent: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'TRIP_COMPLETED', 'RATING_PENDING']] }, '$pricingSnapshot.finalPriceMinor', 0] } },
          },
        },
      ]),
      Rating.find({ customerId: c._id }).sort({ createdAt: -1 }).limit(20).lean(),
      Complaint.find({ customerId: c._id }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    const drivers = await views.driverInfoMap(ratings.map((r) => r.driverId));
    ok(res, {
      customer: {
        _id: c._id,
        userId: u._id,
        name: views.displayName(u),
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        username: u.username || '',
        phone: u.phone || '',
        isActive: u.isActive !== false,
        createdAt: c.createdAt,
      },
      stats: totals[0] || { total: 0, completed: 0, cancelled: 0, spent: 0 },
      orders: await views.enrichOrders(orders),
      ratings: ratings.map((r) => ({ ...r, driver: drivers.get(String(r.driverId)) || null })),
      complaints,
    });
  } catch (e) { next(e); }
});

router.post(
  '/customers/:id/block',
  validated(Joi.object({ reason: Joi.string().trim().min(2).max(300).required().messages({ 'any.required': 'Səbəbi yazın', 'string.empty': 'Səbəbi yazın' }) })),
  async (req, res, next) => {
    try {
      const c = await loadCustomerInScope(req, req.params.id);
      const user = await User.findById(c.userId._id);
      user.isActive = false;
      await user.save();
      await RefreshToken.deleteMany({ userId: user._id }).catch(() => {});
      // Açıq tətbiq dərhal xəbər tutsun: hadisə + bağlantıların qırılması
      realtime.toCustomer(c._id, 'account_blocked', { reason: req.body.reason });
      if (realtime.disconnectRoom) {
        const room = `customer:${c._id}`;
        setTimeout(() => realtime.disconnectRoom(room), 1000).unref();
      }
      await audit(req, 'CUSTOMER_BLOCK', 'Customer', c._id, true, false, req.body.reason);
      ok(res, { blocked: true });
    } catch (e) { next(e); }
  }
);

router.post('/customers/:id/unblock', async (req, res, next) => {
  try {
    const c = await loadCustomerInScope(req, req.params.id);
    await User.updateOne({ _id: c.userId._id }, { $set: { isActive: true } });
    await audit(req, 'CUSTOMER_UNBLOCK', 'Customer', c._id, false, true, req.body && req.body.reason);
    ok(res, { blocked: false });
  } catch (e) { next(e); }
});

// =============================================================== 6. Canlı xəritə

router.get('/live', async (req, res, next) => {
  try {
    const dq = driverFilter(req, { deletedAt: null, isOnline: true });
    const drivers = await Driver.find(dq).select('location locationUpdatedAt currentOrderId').limit(1000).lean();
    const info = await views.driverInfoMap(drivers.map((d) => d._id));
    const scope = await scopedOrderFilter(req);
    const activeStatuses = ['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ON_THE_WAY', 'DRIVER_HEADING_TO_CUSTOMER', 'DRIVER_ARRIVED', 'TRIP_STARTED'];
    const oq = { status: { $in: activeStatuses }, deletedAt: null };
    if (scope) oq.$and = [scope];
    else if (req.query.cityId) oq.cityId = views.oid(req.query.cityId);
    const orders = await Order.find(oq)
      .select('status pickup pickupAddress stops driverId pricingSnapshot.finalPriceMinor createdAt cityId')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    const { isSuper, cityId } = scopeOf(req);
    const center = isSuper && !req.query.cityId ? null : await City.findById(isSuper ? req.query.cityId : cityId).select('name center').lean();
    ok(res, {
      center: center && center.center && center.center.lat != null ? center.center : null,
      drivers: drivers
        .filter((d) => d.location && d.location.coordinates && (d.location.coordinates[0] || d.location.coordinates[1]))
        .map((d) => ({
          _id: d._id,
          lat: d.location.coordinates[1],
          lng: d.location.coordinates[0],
          busy: !!d.currentOrderId,
          updatedAt: d.locationUpdatedAt,
          name: (info.get(String(d._id)) || {}).name || '',
          plate: (info.get(String(d._id)) || {}).plate || '',
          phone: (info.get(String(d._id)) || {}).phone || '',
        })),
      orders: orders.map((o) => ({
        _id: o._id,
        status: o.status,
        lat: o.pickup.coordinates[1],
        lng: o.pickup.coordinates[0],
        pickupAddress: o.pickupAddress,
        destination: (o.stops && o.stops.length && (o.stops[o.stops.length - 1].address || o.stops[o.stops.length - 1].label)) || '',
        driverId: o.driverId,
        priceMinor: o.pricingSnapshot && o.pricingSnapshot.finalPriceMinor,
        createdAt: o.createdAt,
      })),
    });
  } catch (e) { next(e); }
});

// =============================================================== 7. Hesabatlar

/**
 * ?from=&to= (ISO), ?groupBy=day|driver|city, ?cityId= (baş admin)
 * Mənbə: TripEarning (tamamlanmış səfərlərin qazanc/komissiya qeydi; sifariş silinsə də qalır).
 */
router.get('/reports', async (req, res, next) => {
  try {
    const from = new Date(req.query.from);
    const to = new Date(req.query.to);
    const match = { completedAt: {} };
    match.completedAt.$gte = Number.isNaN(from.getTime()) ? views.dayStartBaku(new Date(Date.now() - 29 * 86400000)) : from;
    if (!Number.isNaN(to.getTime())) match.completedAt.$lte = to;
    let ids = await scopedDriverIds(req);
    if (!ids && req.query.cityId) ids = await Driver.find(driverFilter(req)).distinct('_id');
    if (ids) match.driverId = { $in: ids };
    const groupBy = ['day', 'driver', 'city'].includes(req.query.groupBy) ? req.query.groupBy : 'day';

    const base = [
      { $match: match },
      ...(groupBy === 'city'
        ? [
            { $lookup: { from: 'drivers', localField: 'driverId', foreignField: '_id', as: 'd' } },
            { $addFields: { cityId: { $arrayElemAt: ['$d.cityId', 0] } } },
          ]
        : []),
    ];
    const key =
      groupBy === 'day'
        ? { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: '+04:00' } }
        : groupBy === 'driver'
          ? '$driverId'
          : '$cityId';
    const rows = await TripEarning.aggregate([
      ...base,
      {
        $group: {
          _id: key,
          trips: { $sum: 1 },
          gross: { $sum: '$grossMinor' },
          commission: { $sum: '$commissionMinor' },
          net: { $sum: '$netMinor' },
          distance: { $sum: { $ifNull: ['$distanceMeters', 0] } },
        },
      },
      { $sort: groupBy === 'day' ? { _id: 1 } : { gross: -1 } },
      { $limit: 1000 },
    ]);

    let labels = new Map();
    if (groupBy === 'driver') {
      const info = await views.driverInfoMap(rows.map((r) => r._id));
      labels = new Map([...info].map(([k, v]) => [k, { label: v.name || 'Sürücü', sub: [v.phone, v.cityName].filter(Boolean).join(' · ') }]));
    } else if (groupBy === 'city') {
      const cities = await City.find({ _id: { $in: rows.map((r) => r._id).filter(Boolean) } }).select('name').lean();
      labels = new Map(cities.map((c) => [String(c._id), { label: c.name }]));
    }
    const out = rows.map((r) => ({
      key: r._id,
      label: groupBy === 'day' ? r._id : (labels.get(String(r._id)) || {}).label || (groupBy === 'city' ? 'Şəhər seçilməyib' : '—'),
      sub: (labels.get(String(r._id)) || {}).sub || '',
      trips: r.trips,
      grossMinor: r.gross,
      commissionMinor: r.commission,
      netMinor: r.net,
      distanceKm: Math.round((r.distance || 0) / 100) / 10,
    }));
    const totals = out.reduce(
      (t, r) => ({
        trips: t.trips + r.trips,
        grossMinor: t.grossMinor + r.grossMinor,
        commissionMinor: t.commissionMinor + r.commissionMinor,
        netMinor: t.netMinor + r.netMinor,
      }),
      { trips: 0, grossMinor: 0, commissionMinor: 0, netMinor: 0 }
    );
    // Eyni dövrdə ləğv/cavabsız sifarişlər (kontekst üçün)
    const scope = await scopedOrderFilter(req);
    const oq = { createdAt: match.completedAt, ...(scope ? { $and: [scope] } : {}) };
    const [cancelled, expired] = await Promise.all([
      Order.countDocuments({ ...oq, status: { $in: ['CUSTOMER_CANCELLED', 'DRIVER_CANCELLED', 'ADMIN_CANCELLED'] } }),
      Order.countDocuments({ ...oq, status: 'EXPIRED' }),
    ]);
    ok(res, { groupBy, from: match.completedAt.$gte, to: match.completedAt.$lte || new Date(), rows: out, totals: { ...totals, cancelled, expired } });
  } catch (e) { next(e); }
});

// =============================================================== 9. Sürücü məlumatının düzəlişi

router.patch(
  '/drivers/:id/profile',
  validated(Joi.object({
    firstName: Joi.string().trim().min(1).max(50).required().messages({ 'string.empty': 'Adı yazın' }),
    lastName: Joi.string().trim().min(1).max(50).required().messages({ 'string.empty': 'Soyadı yazın' }),
    reason: Joi.string().allow('').max(300),
  })),
  async (req, res, next) => {
    try {
      const driver = await loadDriverInScope(req, req.params.id);
      const user = await User.findById(driver.userId);
      const old = { firstName: user.firstName, lastName: user.lastName };
      user.firstName = req.body.firstName;
      user.lastName = req.body.lastName;
      await user.save();
      await audit(req, 'DRIVER_PROFILE_EDIT', 'Driver', driver._id, old, { firstName: user.firstName, lastName: user.lastName }, req.body.reason);
      adminFeed.driverChanged(driver._id, 'profile');
      ok(res, { saved: true });
    } catch (e) { next(e); }
  }
);

router.put(
  '/drivers/:id/vehicle',
  validated(Joi.object({
    make: Joi.string().trim().min(1).max(40).required().messages({ 'string.empty': 'Markanı yazın' }),
    model: Joi.string().trim().min(1).max(40).required().messages({ 'string.empty': 'Modeli yazın' }),
    color: Joi.string().trim().min(1).max(30).required().messages({ 'string.empty': 'Rəngi yazın' }),
    plateNumber: Joi.string().trim().min(4).max(12).required().messages({ 'string.empty': 'Nömrə nişanını yazın', 'string.min': 'Nömrə nişanı düzgün deyil' }),
    year: Joi.number().integer().min(1980).max(new Date().getFullYear() + 1).allow(null),
    reason: Joi.string().allow('').max(300),
  })),
  async (req, res, next) => {
    try {
      const driver = await loadDriverInScope(req, req.params.id);
      const { reason, ...data } = req.body;
      data.plateNumber = data.plateNumber.replace(/\s+/g, '').toUpperCase();
      let vehicle = driver.vehicleId ? await Vehicle.findById(driver.vehicleId) : await Vehicle.findOne({ driverId: driver._id });
      const old = vehicle ? vehicle.toObject() : null;
      try {
        if (vehicle) {
          vehicle.set(data);
          await vehicle.save();
        } else {
          vehicle = await Vehicle.create({ ...data, driverId: driver._id });
          driver.vehicleId = vehicle._id;
          await driver.save();
        }
      } catch (e) {
        if (e && e.code === 11000) throw new AppError('PLATE_TAKEN', 'Bu nömrə nişanı artıq qeydiyyatdadır', 409);
        throw e;
      }
      await audit(req, 'DRIVER_VEHICLE_EDIT', 'Driver', driver._id, old, vehicle.toObject(), reason);
      ok(res, { vehicle });
    } catch (e) { next(e); }
  }
);

// =============================================================== 11. Əməliyyat jurnalı

const ACTIONS_HIDDEN = new Set(['LOGIN']);

/** ?page=&action=&actorId= — regional admin yalnız öz əməliyyatlarını görür. */
router.get('/audit', async (req, res, next) => {
  try {
    const { isSuper } = scopeOf(req);
    const q = { actorRole: 'ADMIN', action: { $nin: [...ACTIONS_HIDDEN] } };
    if (!isSuper) q.actorId = req.user._id;
    else if (req.query.actorId) q.actorId = views.oid(req.query.actorId);
    if (req.query.action) q.action = String(req.query.action);
    const { skip, limit, page } = views.paging(req.query, 50);
    const [logs, total] = await Promise.all([
      AuditLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(q),
    ]);
    const admins = await User.find({ _id: { $in: [...new Set(logs.map((l) => String(l.actorId)))] } }).select('firstName lastName phone').lean();
    const names = new Map(admins.map((a) => [String(a._id), views.displayName(a) || a.phone]));
    const driverIds = logs.filter((l) => l.entityType === 'Driver' && l.entityId).map((l) => l.entityId);
    const drivers = await views.driverInfoMap(driverIds);
    ok(res, {
      logs: logs.map((l) => ({
        _id: l._id,
        action: l.action,
        actorId: l.actorId,
        actorName: names.get(String(l.actorId)) || 'Admin',
        entityType: l.entityType,
        entityId: l.entityId,
        entityName: l.entityType === 'Driver' ? (drivers.get(String(l.entityId)) || {}).name || '' : '',
        reason: l.reason || '',
        newValue: l.newValue,
        createdAt: l.createdAt,
      })),
      total,
      page,
      limit,
    });
  } catch (e) { next(e); }
});

module.exports = router;
