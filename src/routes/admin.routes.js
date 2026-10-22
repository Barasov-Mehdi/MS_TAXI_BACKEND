const router = require('express').Router();
const mongoose = require('mongoose');
const Joi = require('joi');
const { authenticate, requireRoles } = require('../middleware/auth');
const {
  scopeOf, requireSuperAdmin, driverFilter, loadDriverInScope, scopedDriverIds, loadOrderInScope, scopedOrderFilter,
} = require('../middleware/adminScope');
const { ok, AppError } = require('../utils/errors');
const { getSettings, setSetting } = require('../services/settings.service');
const orderService = require('../services/order.service');
const { isActive } = require('../utils/orderStatus');
const walletService = require('../services/wallet.service');
const pushService = require('../services/push.service');
const dispatchService = require('../services/dispatch.service');
const supportService = require('../services/support.service');
const cityService = require('../services/city.service');
const { publicUser } = require('../services/auth.service');
const { normalizePhone } = require('../utils/validators');
const views = require('../services/adminViews.service');
const { softDeleteDriver } = require('../services/driverAdmin.service');
const realtime = require('../websocket/emitter');
const {
  Order, Driver, Customer, User, Complaint, OrderIssue, City, Rating, Vehicle, TripEarning,
  OrderStatusHistory, Message, DriverDeleteRequest, SupportThread, DriverDocument,
  PricingRule, PromoCode, WalletTransaction, AuditLog,
} = require('../models');

/**
 * Admin API.
 *  Baş admin (User.adminCityId = null)  → hər şey.
 *  Regional admin (User.adminCityId dolu) → yalnız öz şəhərinin sürücüləri, onların sifarişləri, balansı, yazışmaları.
 *  Səlahiyyət yoxlaması: middleware/adminScope.js
 */
router.use(authenticate, requireRoles('ADMIN'));

async function audit(req, action, entityType, entityId, oldValue, newValue, reason) {
  await AuditLog.create({
    actorId: req.user._id,
    actorRole: 'ADMIN',
    action,
    entityType,
    entityId,
    oldValue,
    newValue,
    reason,
    ip: req.ip,
  });
}

function validated(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body || {}, { stripUnknown: true });
    if (error) return next(new AppError('VALIDATION_ERROR', error.details[0].message, 400));
    req.body = value;
    next();
  };
}

const objectId = Joi.string().hex().length(24);

// =============================================================== Mən (panel üçün)

/** Panel hansı bölmələri göstərəcəyini buradan bilir. */
router.get('/me', async (req, res, next) => {
  try {
    const { isSuper, cityId } = scopeOf(req);
    ok(res, {
      user: publicUser(req.user),
      isSuperAdmin: isSuper,
      city: isSuper ? null : cityService.publicCity(await cityService.getCity(cityId)),
    });
  } catch (e) { next(e); }
});

/** İdarə paneli: əsas göstəricilər (regional admin üçün öz şəhəri). */
router.get('/stats', async (req, res, next) => {
  try {
    const { isSuper, cityId } = scopeOf(req);
    const dFilter = driverFilter(req, { deletedAt: null });
    const today = views.dayStartBaku();
    const ids = await scopedDriverIds(req); // null → hamısı
    const orderScope = (await scopedOrderFilter(req)) || {};
    const earnScope = ids ? { driverId: { $in: ids } } : {};
    const [
      driversTotal, driversOnline, driversPending, driversBlocked,
      ordersToday, completedToday, cancelledToday, activeNow, earnToday,
      unreadSupport, pendingDeletes, openIssues, searchingNow, expiredToday, docsPending,
    ] = await Promise.all([
      Driver.countDocuments(dFilter),
      Driver.countDocuments({ ...dFilter, isOnline: true }),
      Driver.countDocuments({ ...dFilter, isVerified: false, isActive: true }),
      Driver.countDocuments({ ...dFilter, isActive: false }),
      Order.countDocuments({ ...orderScope, createdAt: { $gte: today }, deletedAt: null }),
      Order.countDocuments({ ...orderScope, completedAt: { $gte: today }, status: { $in: ['COMPLETED', 'TRIP_COMPLETED', 'RATING_PENDING'] } }),
      Order.countDocuments({ ...orderScope, cancelledAt: { $gte: today } }),
      Order.countDocuments({ ...orderScope, status: { $in: ['DRIVER_ASSIGNED', 'DRIVER_ON_THE_WAY', 'DRIVER_HEADING_TO_CUSTOMER', 'DRIVER_ARRIVED', 'TRIP_STARTED'] } }),
      TripEarning.aggregate([
        { $match: { ...earnScope, completedAt: { $gte: today } } },
        { $group: { _id: null, gross: { $sum: '$grossMinor' }, commission: { $sum: '$commissionMinor' } } },
      ]),
      SupportThread.aggregate([
        { $match: isSuper ? {} : { cityId: new mongoose.Types.ObjectId(cityId) } },
        { $group: { _id: null, n: { $sum: '$unreadForAdmin' } } },
      ]),
      DriverDeleteRequest.countDocuments({ status: 'PENDING', ...(isSuper ? {} : { cityId: new mongoose.Types.ObjectId(cityId) }) }),
      OrderIssue.countDocuments({
        status: 'OPEN',
        ...(ids ? { orderId: { $in: await Order.find({ driverId: { $in: ids } }).distinct('_id') } } : {}),
      }),
      Order.countDocuments({ ...orderScope, status: 'SEARCHING_DRIVER' }),
      Order.countDocuments({ ...orderScope, status: 'EXPIRED', updatedAt: { $gte: today } }),
      DriverDocument.distinct('driverId', { status: 'PENDING', ...(ids ? { driverId: { $in: ids } } : {}) }).then((l) => l.length),
    ]);
    // Son 7 gün (qrafik üçün)
    const weekStart = new Date(today.getTime() - 6 * 86400000);
    const week = await TripEarning.aggregate([
      { $match: { ...earnScope, completedAt: { $gte: weekStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: '+04:00' } },
          trips: { $sum: 1 },
          gross: { $sum: '$grossMinor' },
          commission: { $sum: '$commissionMinor' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    ok(res, {
      drivers: { total: driversTotal, online: driversOnline, pending: driversPending, blocked: driversBlocked },
      orders: { today: ordersToday, completedToday, cancelledToday, activeNow },
      money: { grossToday: (earnToday[0] && earnToday[0].gross) || 0, commissionToday: (earnToday[0] && earnToday[0].commission) || 0 },
      unreadSupport: (unreadSupport[0] && unreadSupport[0].n) || 0,
      pendingDeleteRequests: pendingDeletes,
      openIssues,
      unassigned: { searchingNow, expiredToday },
      driversWithPendingDocs: docsPending,
      week,
    });
  } catch (e) { next(e); }
});

// =============================================================== Sifarişlər

const STATUS_GROUPS = {
  active: ['CREATED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ON_THE_WAY', 'DRIVER_HEADING_TO_CUSTOMER', 'DRIVER_ARRIVED', 'TRIP_STARTED', 'QUEUED', 'DRIVER_FINISHING_CURRENT_TRIP', 'WAITING_FOR_ADMIN', 'DISPUTED'],
  // Sürücüsü olmayan: hələ axtarılır və ya heç kim tapılmayıb (ofis əl ilə təyin edə bilər)
  unassigned: ['SEARCHING_DRIVER', 'EXPIRED'],
  completed: ['COMPLETED', 'TRIP_COMPLETED', 'RATING_PENDING'],
  cancelled: ['CUSTOMER_CANCELLED', 'DRIVER_CANCELLED', 'ADMIN_CANCELLED', 'EXPIRED'],
};

const escRx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sifarişlər: ?group=active|unassigned|completed|cancelled | ?status=, ?driverId=, ?customerId=, ?from=&to= (ISO),
 * ?q= sifariş ID / müştəri və ya sürücü telefonu / adı, ?page=&limit=.
 * Regional admin: öz şəhərinin sürücülərinin sifarişləri + götürmə nöqtəsi öz şəhərində olanlar.
 */
router.get('/orders', async (req, res, next) => {
  try {
    const and = [];
    const q = {};
    if (req.query.group && STATUS_GROUPS[req.query.group]) q.status = { $in: STATUS_GROUPS[req.query.group] };
    else if (req.query.status) q.status = String(req.query.status);
    if (req.query.group === 'unassigned') q.driverId = null;
    // Silinmiş (yumşaq) sifarişlər standart olaraq göstərilmir: ?includeDeleted=1 ilə görünür
    if (req.query.includeDeleted !== '1') q.deletedAt = null;
    if (req.query.from || req.query.to) {
      q.createdAt = {};
      const f = new Date(req.query.from);
      const t = new Date(req.query.to);
      if (!Number.isNaN(f.getTime())) q.createdAt.$gte = f;
      if (!Number.isNaN(t.getTime())) q.createdAt.$lte = t;
    }
    if (req.query.q) {
      const text = String(req.query.q).trim().slice(0, 60);
      const id = views.oid(text);
      if (id) q._id = id;
      else if (text.length >= 2) {
        const rx = new RegExp(escRx(text), 'i');
        const phone = normalizePhone(text);
        const users = await User.find({
          role: { $in: ['CUSTOMER', 'DRIVER'] },
          $or: [{ firstName: rx }, { lastName: rx }, { username: rx }, { phone: rx }, ...(phone ? [{ phone }] : [])],
        }).select('_id').limit(500).lean();
        const uids = users.map((u) => u._id);
        const [cust, drv] = await Promise.all([
          Customer.find({ userId: { $in: uids } }).distinct('_id'),
          Driver.find({ userId: { $in: uids } }).distinct('_id'),
        ]);
        and.push({ $or: [{ customerId: { $in: cust } }, { driverId: { $in: drv } }, { 'passenger.phone': rx }, { 'passenger.name': rx }] });
      }
    }
    if (req.query.customerId) q.customerId = views.oid(req.query.customerId);
    if (req.query.driverId) {
      q.driverId = (await loadDriverInScope(req, req.query.driverId, { allowDeleted: true }))._id;
    } else if (scopeOf(req).isSuper && req.query.cityId) {
      const cid = views.oid(req.query.cityId);
      and.push({ $or: [{ cityId: cid }, { driverId: { $in: await Driver.find(driverFilter(req)).distinct('_id') } }] });
    }
    const scope = await scopedOrderFilter(req);
    if (scope) and.push(scope);
    if (and.length) q.$and = and;
    const { skip, limit, page } = views.paging(req.query);
    const [orders, total] = await Promise.all([
      Order.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(q),
    ]);
    ok(res, { orders: await views.enrichOrders(orders), total, page, limit });
  } catch (e) { next(e); }
});

/**
 * Sifarişi SİL (yumşaq silmə). Bazadan əl ilə silmək əvəzinə bunu istifadə edin:
 * sənəd qalır (deletedAt qoyulur), admin siyahısında görünmür, sürücünün qazanc/statistikası pozulmur.
 * Aktiv sifarişdirsə əvvəlcə admin tərəfindən ləğv olunur.
 */
router.delete('/orders/:id', async (req, res, next) => {
  try {
    let order = await loadOrderInScope(req, req.params.id);
    if (!order.deletedAt) {
      if (isActive(order.status) && !['TRIP_COMPLETED', 'RATING_PENDING', 'DISPUTED', 'WAITING_FOR_ADMIN'].includes(order.status)) {
        order = await orderService.cancelOrder({ order, user: req.user, role: 'ADMIN', reason: req.body?.reason || 'Admin tərəfindən silindi' });
      }
      await Order.updateOne({ _id: order._id }, { $set: { deletedAt: new Date() } });
      await audit(req, 'ORDER_DELETE', 'Order', order._id, null, { deletedAt: true }, req.body?.reason);
    }
    ok(res, { deleted: true });
  } catch (e) { next(e); }
});

/** Silinmiş sifarişi geri qaytar. */
router.post('/orders/:id/restore', async (req, res, next) => {
  try {
    const order = await loadOrderInScope(req, req.params.id);
    await Order.updateOne({ _id: order._id }, { $set: { deletedAt: null } });
    await audit(req, 'ORDER_RESTORE', 'Order', order._id, null, null);
    ok(res, { restored: true });
  } catch (e) { next(e); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    ok(res, { order: await loadOrderInScope(req, req.params.id) });
  } catch (e) { next(e); }
});

/** Sifarişin tam təfərrüatı: sürücü, müştəri, status tarixçəsi, reytinq, şikayətlər, problemlər, qazanc, çat. */
router.get('/orders/:id/details', async (req, res, next) => {
  try {
    const order = await loadOrderInScope(req, req.params.id);
    const o = order.toObject();
    const [enriched] = await views.enrichOrders([o]);
    const [history, rating, complaints, issues, earning, messages] = await Promise.all([
      OrderStatusHistory.find({ orderId: o._id }).sort({ createdAt: 1 }).lean(),
      Rating.findOne({ orderId: o._id }).lean(),
      Complaint.find({ orderId: o._id }).sort({ createdAt: -1 }).lean(),
      OrderIssue.find({ orderId: o._id }).sort({ createdAt: -1 }).lean(),
      TripEarning.findOne({ orderId: o._id }).lean(),
      Message.find({ orderId: o._id }).sort({ createdAt: 1 }).limit(200).lean().catch(() => []),
    ]);
    const drv = o.driverId ? await Driver.findById(o.driverId).select('userId').lean() : null;
    const driverUserId = drv ? String(drv.userId) : null;
    const chat = (messages || []).map((m) => ({
      _id: m._id,
      text: m.message,
      createdAt: m.createdAt,
      senderRole: driverUserId && String(m.senderId) === driverUserId ? 'DRIVER' : 'CUSTOMER',
    }));
    ok(res, { order: enriched, history, rating, complaints, issues, earning, messages: chat });
  } catch (e) { next(e); }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const order = await loadOrderInScope(req, req.params.id);
    const updated = await orderService.cancelOrder({ order, user: req.user, role: 'ADMIN', reason: req.body.reason });
    await audit(req, 'ORDER_CANCEL', 'Order', order._id, null, updated.status, req.body.reason);
    ok(res, { order: updated });
  } catch (e) { next(e); }
});

router.post('/orders/:id/reassign', async (req, res, next) => {
  try {
    const order = await loadOrderInScope(req, req.params.id);
    // Yeni sürücü də adminin səlahiyyətində olmalıdır
    await loadDriverInScope(req, req.body.driverId);
    const updated = await orderService.adminReassign({
      order, newDriverId: req.body.driverId, adminUser: req.user, reason: req.body.reason,
    });
    await audit(req, 'ORDER_REASSIGN', 'Order', order._id, order.driverId, req.body.driverId, req.body.reason);
    ok(res, { order: updated });
  } catch (e) { next(e); }
});

// =============================================================== Sürücülər

/**
 * Sürücülər: ?status=pending|active|blocked|online|deleted, ?q= ad/telefon/nömrə nişanı,
 * ?cityId=<id>|none (yalnız baş admin), ?page=&limit=
 */
router.get('/drivers', async (req, res, next) => {
  try {
    const st = String(req.query.status || '');
    const q = driverFilter(req, { deletedAt: st === 'deleted' ? { $ne: null } : null });
    if (st === 'pending') Object.assign(q, { isVerified: false, isActive: true });
    if (st === 'active') Object.assign(q, { isVerified: true, isActive: true });
    if (st === 'blocked') q.isActive = false;
    if (st === 'online') q.isOnline = true;
    if (st === 'deleted' && !scopeOf(req).isSuper) throw new AppError('FORBIDDEN', 'Insufficient role', 403);
    if (req.query.online === '1') q.isOnline = true;
    if (req.query.q) {
      const text = String(req.query.q).trim().slice(0, 50);
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const phone = normalizePhone(text);
      const [users, vehicles] = await Promise.all([
        User.find({
          role: 'DRIVER',
          $or: [{ firstName: rx }, { lastName: rx }, { phone: rx }, { deletedPhone: rx }, ...(phone ? [{ phone }] : [])],
        }).distinct('_id'),
        Vehicle.find({ plateNumber: rx }).distinct('driverId'),
      ]);
      q.$or = [{ userId: { $in: users } }, { _id: { $in: vehicles } }];
    }
    const { skip, limit, page } = views.paging(req.query, 30);
    const [docs, total] = await Promise.all([
      Driver.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).select('-fcmToken').lean(),
      Driver.countDocuments(q),
    ]);
    const info = await views.driverInfoMap(docs.map((d) => d._id));
    const drivers = docs.map((d) => ({ ...d, ...info.get(String(d._id)), _id: d._id }));
    ok(res, { drivers, total, page, limit });
  } catch (e) { next(e); }
});

router.get('/drivers/:id', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id, { allowDeleted: true });
    await driver.populate('userId');
    await driver.populate('cityId', 'name');
    ok(res, { driver });
  } catch (e) { next(e); }
});

/** Sürücü kartı: profil, avtomobil, statistika, son sifarişlər, reytinqlər, balans hərəkəti, silmə sorğusu. */
router.get('/drivers/:id/overview', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id, { allowDeleted: true });
    const d = driver.toObject();
    delete d.fcmToken;
    const [user, vehicle, city, totals, orders, ratings, transactions, deleteRequest, complaints] = await Promise.all([
      User.findById(d.userId).select('firstName lastName phone deletedPhone isActive createdAt').lean(),
      Vehicle.findOne({ driverId: d._id }).sort({ createdAt: -1 }).lean(),
      d.cityId ? City.findById(d.cityId).select('name').lean() : null,
      TripEarning.aggregate([
        { $match: { driverId: d._id } },
        { $group: { _id: null, trips: { $sum: 1 }, gross: { $sum: '$grossMinor' }, commission: { $sum: '$commissionMinor' } } },
      ]),
      Order.find({ driverId: d._id }).sort({ createdAt: -1 }).limit(15).lean(),
      Rating.find({ driverId: d._id }).sort({ createdAt: -1 }).limit(20).lean(),
      WalletTransaction.find({ driverId: d._id }).sort({ createdAt: -1 }).limit(20).lean(),
      DriverDeleteRequest.findOne({ driverId: d._id }).sort({ createdAt: -1 }).lean(),
      Complaint.countDocuments({ driverId: d._id }),
    ]);
    const customers = await views.customerInfoMap(ratings.map((r) => r.customerId));
    ok(res, {
      driver: d,
      user: user ? { ...user, phone: user.deletedPhone || user.phone } : null,
      vehicle: vehicle ? { ...vehicle, plateNumber: String(vehicle.plateNumber || '').replace(/#del\d+$/, '') } : null,
      city,
      stats: {
        trips: (totals[0] && totals[0].trips) || 0,
        grossMinor: (totals[0] && totals[0].gross) || 0,
        commissionMinor: (totals[0] && totals[0].commission) || 0,
        complaints,
      },
      orders: await views.enrichOrders(orders),
      ratings: ratings.map((r) => ({ ...r, customer: customers.get(String(r.customerId)) || null })),
      transactions,
      deleteRequest,
      documents: (await require('../services/document.service').listForDriver(d._id)).summary,
    });
  } catch (e) { next(e); }
});

router.patch('/drivers/:id', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id);
    const old = driver.toObject();
    // Yalnız icazə verilən sahələr: body-dən bakiye, cari sifariş, FCM token və s. dəyişdirilə bilməz
    // (bakiye üçün /wallet/top-up və /wallet/adjustment istifadə olunur - audit və idempotency ilə).
    const ALLOWED = ['isVerified', 'isActive', 'priority', 'radiusMeters'];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) driver[key] = req.body[key];
    }
    // Şəhəri yalnız baş admin dəyişə bilər (regional admin sürücünü başqa ofisə "ötürə" bilməz)
    if (req.body.cityId !== undefined) {
      if (!scopeOf(req).isSuper) throw new AppError('FORBIDDEN', 'Şəhəri yalnız baş admin dəyişə bilər', 403);
      driver.cityId = req.body.cityId ? (await cityService.requireActiveCity(req.body.cityId))._id : null;
    }
    // Təsdiqi götürülən / bloklanan sürücü onlayn qalmasın: əks halda tətbiqdə "Onlayn" görünür, amma heç vaxt sifariş almır.
    const lostAccess = driver.isOnline && (!driver.isVerified || !driver.isActive);
    if (lostAccess) {
      driver.isOnline = false;
      driver.onlineSince = null;
    }
    await driver.save();
    if (lostAccess) {
      realtime.toDriver(driver._id, 'driver_offline', { reason: driver.isActive ? 'NOT_VERIFIED' : 'BLOCKED' });
      await dispatchService.advanceOffersOfDriver(driver._id, 'DRIVER_OFFLINE').catch(() => {});
    }
    await audit(req, 'DRIVER_UPDATE', 'Driver', driver._id, old, driver.toObject(), req.body.reason);
    // Hesab statusu dəyişibsə sürücüyə bildiriş (təsdiq / deaktiv)
    if (old.isVerified !== driver.isVerified) {
      pushService.notifyAccount(driver._id, driver.isVerified ? 'verified' : 'unverified').catch(() => {});
    }
    if (old.isActive !== driver.isActive) {
      pushService.notifyAccount(driver._id, driver.isActive ? 'activated' : 'blocked').catch(() => {});
    }
    ok(res, { driver });
  } catch (e) { next(e); }
});

// =============================================================== Sürücünü silmək
// Regional admin silə bilməz: sorğu göndərir. Baş admin birbaşa silir və ya sorğunu təsdiqləyir.

router.post(
  '/drivers/:id/delete-request',
  validated(Joi.object({ reason: Joi.string().trim().min(3).max(500).required() })),
  async (req, res, next) => {
    try {
      const driver = await loadDriverInScope(req, req.params.id);
      const info = (await views.driverInfoMap([driver._id])).get(String(driver._id)) || {};
      let request;
      try {
        request = await DriverDeleteRequest.create({
          driverId: driver._id,
          cityId: driver.cityId || null,
          requestedBy: req.user._id,
          requestedByName: views.displayName(req.user),
          reason: req.body.reason,
          driverName: info.name || '',
          driverPhone: info.phone || '',
        });
      } catch (e) {
        if (e && e.code === 11000) throw new AppError('REQUEST_EXISTS', 'Bu sürücü üçün artıq gözləyən sorğu var', 409);
        throw e;
      }
      await audit(req, 'DRIVER_DELETE_REQUEST', 'Driver', driver._id, null, { requestId: request._id }, req.body.reason);
      realtime.toAdmin('delete_request', { request, cityName: info.cityName || '' });
      ok(res, { request }, {}, 201);
    } catch (e) { next(e); }
  }
);

/** Sorğular: baş admin hamısını, regional admin öz şəhərininkiləri görür. ?status=PENDING|APPROVED|REJECTED */
router.get('/delete-requests', async (req, res, next) => {
  try {
    const { isSuper, cityId } = scopeOf(req);
    const q = isSuper ? {} : { cityId: new mongoose.Types.ObjectId(cityId) };
    if (req.query.status) q.status = String(req.query.status);
    const requests = await DriverDeleteRequest.find(q).sort({ createdAt: -1 }).limit(200).lean();
    const cities = await City.find({ _id: { $in: requests.map((r) => r.cityId).filter(Boolean) } }).select('name').lean();
    const cityName = new Map(cities.map((c) => [String(c._id), c.name]));
    ok(res, { requests: requests.map((r) => ({ ...r, cityName: r.cityId ? cityName.get(String(r.cityId)) || '' : '' })) });
  } catch (e) { next(e); }
});

/** Regional admin öz sorğusunu geri götürə bilər. */
router.post('/delete-requests/:id/cancel', async (req, res, next) => {
  try {
    const r = await DriverDeleteRequest.findOne({ _id: views.oid(req.params.id), status: 'PENDING' });
    if (!r) throw new AppError('NOT_FOUND', 'Sorğu tapılmadı', 404);
    if (!scopeOf(req).isSuper && String(r.requestedBy) !== String(req.user._id)) throw new AppError('FORBIDDEN', 'Insufficient role', 403);
    r.status = 'CANCELLED';
    r.reviewedBy = req.user._id;
    r.reviewedAt = new Date();
    await r.save();
    ok(res, { request: r });
  } catch (e) { next(e); }
});

router.post(
  '/delete-requests/:id/approve',
  requireSuperAdmin,
  validated(Joi.object({ note: Joi.string().allow('').max(500) })),
  async (req, res, next) => {
    try {
      const r = await DriverDeleteRequest.findOne({ _id: views.oid(req.params.id), status: 'PENDING' });
      if (!r) throw new AppError('NOT_FOUND', 'Sorğu tapılmadı', 404);
      await softDeleteDriver(r.driverId, req.user);
      r.status = 'APPROVED';
      r.reviewedBy = req.user._id;
      r.reviewedAt = new Date();
      r.reviewNote = req.body.note || '';
      await r.save();
      await audit(req, 'DRIVER_DELETE', 'Driver', r.driverId, null, { requestId: r._id }, r.reason);
      realtime.toAdminCity(r.cityId, 'delete_request_updated', { request: r });
      ok(res, { request: r });
    } catch (e) { next(e); }
  }
);

router.post(
  '/delete-requests/:id/reject',
  requireSuperAdmin,
  validated(Joi.object({ note: Joi.string().allow('').max(500) })),
  async (req, res, next) => {
    try {
      const r = await DriverDeleteRequest.findOne({ _id: views.oid(req.params.id), status: 'PENDING' });
      if (!r) throw new AppError('NOT_FOUND', 'Sorğu tapılmadı', 404);
      r.status = 'REJECTED';
      r.reviewedBy = req.user._id;
      r.reviewedAt = new Date();
      r.reviewNote = req.body.note || '';
      await r.save();
      realtime.toAdminCity(r.cityId, 'delete_request_updated', { request: r });
      ok(res, { request: r });
    } catch (e) { next(e); }
  }
);

/** Baş admin sürücünü birbaşa silir. */
router.delete('/drivers/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id);
    await softDeleteDriver(driver._id, req.user);
    await DriverDeleteRequest.updateMany(
      { driverId: driver._id, status: 'PENDING' },
      { $set: { status: 'APPROVED', reviewedBy: req.user._id, reviewedAt: new Date() } }
    );
    await audit(req, 'DRIVER_DELETE', 'Driver', driver._id, null, null, req.body && req.body.reason);
    ok(res, { deleted: true });
  } catch (e) { next(e); }
});

// =============================================================== Ofis ↔ sürücü yazışması

/** Yazışmalar siyahısı (son mesaja görə). ?unread=1 yalnız cavabsızlar. Baş admin ?cityId= ilə süzə bilər. */
router.get('/support/threads', async (req, res, next) => {
  try {
    const { isSuper, cityId } = scopeOf(req);
    let city;
    if (!isSuper) city = new mongoose.Types.ObjectId(cityId);
    else if (req.query.cityId === 'none') city = null;
    else if (req.query.cityId && mongoose.isValidObjectId(req.query.cityId)) city = new mongoose.Types.ObjectId(req.query.cityId);
    const threads = await supportService.listThreads({
      cityId: city,
      unreadOnly: req.query.unread === '1',
      limit: req.query.limit,
    });
    ok(res, { threads, unreadTotal: threads.reduce((n, t) => n + (t.unreadForAdmin || 0), 0) });
  } catch (e) { next(e); }
});

router.get('/support/:driverId/messages', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.driverId);
    ok(res, await supportService.listMessages(driver._id, { before: req.query.before, limit: req.query.limit }));
  } catch (e) { next(e); }
});

/** Sürücüyə yaz (sürücü əvvəl yazmayıbsa da olar). */
router.post(
  '/support/:driverId/messages',
  validated(Joi.object({ text: Joi.string().trim().min(1).max(supportService.MAX_LEN).required() })),
  async (req, res, next) => {
    try {
      const driver = await loadDriverInScope(req, req.params.driverId);
      const message = await supportService.sendFromAdmin(req.user, driver, req.body.text);
      ok(res, { message }, {}, 201);
    } catch (e) { next(e); }
  }
);

router.post('/support/:driverId/read', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.driverId);
    await supportService.markReadByAdmin(driver._id);
    ok(res, { unread: 0 });
  } catch (e) { next(e); }
});

/**
 * Hamıya mesaj: regional admin → öz şəhərinin bütün sürücülərinə; baş admin → hamıya və ya ?cityId= şəhərə.
 * Body: { text, onlyActive?: true }
 */
router.post(
  '/support/broadcast',
  validated(Joi.object({
    text: Joi.string().trim().min(1).max(supportService.MAX_LEN).required(),
    cityId: objectId.allow(null, ''),
    onlyActive: Joi.boolean().default(true),
  })),
  async (req, res, next) => {
    try {
      if (req.body.cityId) req.query.cityId = req.body.cityId;
      const q = driverFilter(req, { deletedAt: null });
      if (req.body.onlyActive) q.isActive = true;
      const r = await supportService.broadcast(req.user, q, req.body.text);
      await audit(req, 'SUPPORT_BROADCAST', 'Driver', null, null, { ...r, text: req.body.text, cityId: q.cityId || null });
      ok(res, r);
    } catch (e) { next(e); }
  }
);

// =============================================================== Balans

/** Admin əməliyyatından sonra sürücüyə bildiriş + canlı balans yeniləməsi (xəta əsas cavabı pozmasın). */
function announceBalance(driverId, tx, kind) {
  try {
    realtime.toDriver(driverId, 'balance_updated', { balanceMinor: tx.balanceAfterMinor });
    pushService
      .notifyBalanceChange(driverId, { amountMinor: tx.amountMinor, balanceMinor: tx.balanceAfterMinor, kind })
      .catch((e) => console.error('[push] balans bildirişi alınmadı', e && e.message));
  } catch (e) {
    console.error('[push] balans bildirişi alınmadı', e && e.message);
  }
}

router.get('/wallet-transactions', async (req, res, next) => {
  try {
    const q = {};
    if (req.query.driverId) q.driverId = (await loadDriverInScope(req, req.query.driverId))._id;
    else {
      const ids = await scopedDriverIds(req);
      if (ids) q.driverId = { $in: ids };
    }
    const txs = await WalletTransaction.find(q).sort({ createdAt: -1 }).limit(200).lean();
    const info = await views.driverInfoMap(txs.map((t) => t.driverId));
    ok(res, { transactions: txs.map((t) => ({ ...t, driver: info.get(String(t.driverId)) || null })) });
  } catch (e) { next(e); }
});

router.post('/drivers/:id/wallet/top-up', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id);
    const tx = await walletService.applyTransaction({
      driverId: driver._id,
      type: 'TOP_UP',
      amountMinor: Number(req.body.amountMinor),
      referenceType: 'ADMIN',
      referenceId: req.user._id,
      idempotencyKey: req.headers['idempotency-key'] || `topup:${driver._id}:${Date.now()}`,
      note: req.body.note,
      createdBy: req.user._id,
    });
    await audit(req, 'WALLET_TOPUP', 'Driver', driver._id, null, tx.toObject());
    announceBalance(driver._id, tx, 'TOP_UP');
    ok(res, { transaction: tx });
  } catch (e) { next(e); }
});

router.post('/drivers/:id/wallet/adjustment', requireSuperAdmin, async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id);
    const tx = await walletService.applyTransaction({
      driverId: driver._id,
      type: 'MANUAL_ADJUSTMENT',
      amountMinor: Number(req.body.amountMinor),
      referenceType: 'ADMIN',
      referenceId: req.user._id,
      idempotencyKey: req.headers['idempotency-key'] || `adj:${driver._id}:${Date.now()}`,
      note: req.body.note,
      createdBy: req.user._id,
    });
    await audit(req, 'WALLET_ADJUST', 'Driver', driver._id, null, tx.toObject(), req.body.reason);
    announceBalance(driver._id, tx, 'MANUAL_ADJUSTMENT');
    ok(res, { transaction: tx });
  } catch (e) { next(e); }
});

// =============================================================== Problemlər (sifariş üzrə)

router.get('/issues', async (req, res, next) => {
  try {
    const q = {};
    const ids = await scopedDriverIds(req);
    if (ids) q.orderId = { $in: await Order.find({ driverId: { $in: ids } }).distinct('_id') };
    ok(res, { issues: await OrderIssue.find(q).sort({ createdAt: -1 }).limit(100) });
  } catch (e) { next(e); }
});

router.patch('/issues/:id', async (req, res, next) => {
  try {
    const issue = await OrderIssue.findById(req.params.id);
    if (!issue) throw new AppError('NOT_FOUND', 'Issue not found', 404);
    await loadOrderInScope(req, issue.orderId);
    const ALLOWED = ['status', 'adminNotes'];
    for (const k of ALLOWED) if (req.body[k] !== undefined) issue.set(k, req.body[k]);
    await issue.save();
    ok(res, { issue });
  } catch (e) { next(e); }
});

// =============================================================== Jurnal

router.get('/audit-logs', async (req, res) => {
  // Regional admin yalnız öz əməliyyatlarını görür
  const q = scopeOf(req).isSuper ? {} : { actorId: req.user._id };
  ok(res, { logs: await AuditLog.find(q).sort({ createdAt: -1 }).limit(200) });
});

// =============================================================== Hesabı bağla / aç

async function loadUserInScope(req, userId) {
  if (!mongoose.isValidObjectId(String(userId || ''))) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  const user = await User.findById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  if (scopeOf(req).isSuper) return { user, driver: user.role === 'DRIVER' ? await Driver.findOne({ userId: user._id }) : null };
  // Regional admin yalnız öz şəhərinin sürücü hesabını bağlaya/aça bilər
  if (user.role !== 'DRIVER') throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  const driver = await Driver.findOne({ userId: user._id });
  await loadDriverInScope(req, driver && driver._id);
  return { user, driver };
}

router.post('/users/:id/disable', async (req, res, next) => {
  try {
    const { user, driver } = await loadUserInScope(req, req.params.id);
    if (String(user._id) === String(req.user._id)) throw new AppError('FORBIDDEN', 'Öz hesabınızı bağlaya bilməzsiniz', 403);
    user.isActive = false;
    await user.save();
    if (driver) {
      const drv = await Driver.findOneAndUpdate(
        { _id: driver._id, isOnline: true },
        { $set: { isOnline: false, onlineSince: null } },
        { new: true }
      );
      if (drv) await dispatchService.advanceOffersOfDriver(drv._id, 'DRIVER_OFFLINE').catch(() => {});
      realtime.toDriver(driver._id, 'driver_offline', { reason: 'BLOCKED' });
      pushService.notifyAccount(driver._id, 'blocked').catch(() => {});
    }
    await audit(req, 'USER_DISABLE', 'User', user._id, true, false, req.body.reason);
    ok(res, { user: publicUser(user) });
  } catch (e) { next(e); }
});

router.post('/users/:id/enable', async (req, res, next) => {
  try {
    const { user, driver } = await loadUserInScope(req, req.params.id);
    user.isActive = true;
    await user.save();
    if (driver) pushService.notifyAccount(driver._id, 'activated').catch(() => {});
    await audit(req, 'USER_ENABLE', 'User', user._id, false, true, req.body.reason);
    ok(res, { user: publicUser(user) });
  } catch (e) { next(e); }
});

// =============================================================== YALNIZ BAŞ ADMİN
// Şəhərlər, adminlər, sərnişinlər, şikayətlər, tariflər, promo kodlar, ümumi ayarlar.

// ---- Şəhərlər ----
router.get('/cities', async (req, res, next) => {
  try {
    const { isSuper, cityId } = scopeOf(req);
    // Regional admin öz şəhərini görür (ofis məlumatını yeniləyə bilsin deyə)
    const q = isSuper ? {} : { _id: cityId };
    const cities = await City.find(q).sort({ sortOrder: 1, name: 1 }).lean();
    const counts = await Driver.aggregate([{ $group: { _id: '$cityId', n: { $sum: 1 } } }]);
    const byCity = new Map(counts.map((c) => [String(c._id), c.n]));
    ok(res, { cities: cities.map((c) => ({ ...c, driverCount: byCity.get(String(c._id)) || 0 })) });
  } catch (e) { next(e); }
});

const cityBody = {
  name: Joi.string().trim().min(2).max(80),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0).max(10000),
  officeAddress: Joi.string().allow('').max(300),
  officePhone: Joi.string().allow('').max(30),
  workHours: Joi.string().allow('').max(120),
  center: Joi.object({ lat: Joi.number().min(38).max(42.5).allow(null), lng: Joi.number().min(44).max(51).allow(null) }),
  radiusKm: Joi.number().min(5).max(200),
};

router.post('/cities', requireSuperAdmin, validated(Joi.object({ ...cityBody, name: cityBody.name.required() })), async (req, res, next) => {
  try {
    const city = await City.create(req.body);
    await audit(req, 'CITY_CREATE', 'City', city._id, null, city.toObject());
    ok(res, { city }, {}, 201);
  } catch (e) {
    if (e && e.code === 11000) return next(new AppError('CITY_EXISTS', 'Bu adda şəhər artıq var', 409));
    next(e);
  }
});

/** Regional admin yalnız öz şəhərinin ofis məlumatını (ünvan, telefon, iş saatı) dəyişə bilər. */
router.patch('/cities/:id', validated(Joi.object(cityBody)), async (req, res, next) => {
  try {
    const { isSuper, cityId } = scopeOf(req);
    if (!isSuper && String(req.params.id) !== cityId) throw new AppError('FORBIDDEN', 'Insufficient role', 403);
    const city = await City.findById(req.params.id);
    if (!city) throw new AppError('CITY_NOT_FOUND', 'Şəhər tapılmadı', 404);
    const old = city.toObject();
    const allowed = isSuper ? Object.keys(cityBody) : ['officeAddress', 'officePhone', 'workHours'];
    for (const k of allowed) if (req.body[k] !== undefined) city.set(k, req.body[k]);
    await city.save();
    cityService.invalidateCenters();
    await audit(req, 'CITY_UPDATE', 'City', city._id, old, city.toObject());
    ok(res, { city });
  } catch (e) {
    if (e && e.code === 11000) return next(new AppError('CITY_EXISTS', 'Bu adda şəhər artıq var', 409));
    next(e);
  }
});

// ---- Adminlər ----
router.get('/admins', requireSuperAdmin, async (req, res, next) => {
  try {
    const admins = await User.find({ role: 'ADMIN' }).sort({ createdAt: 1 }).lean();
    const cities = await City.find({ _id: { $in: admins.map((a) => a.adminCityId).filter(Boolean) } }).select('name').lean();
    const names = new Map(cities.map((c) => [String(c._id), c.name]));
    ok(res, {
      admins: admins.map((a) => ({
        ...publicUser(a),
        isActive: a.isActive,
        cityName: a.adminCityId ? names.get(String(a.adminCityId)) || '' : null,
        createdAt: a.createdAt,
      })),
    });
  } catch (e) { next(e); }
});

/** Yeni admin. cityId boşdursa → baş admin; doludursa → həmin şəhərin regional admini. */
router.post(
  '/admins',
  requireSuperAdmin,
  validated(Joi.object({
    phone: Joi.string().required(),
    password: Joi.string().min(8).max(100).required(),
    firstName: Joi.string().trim().allow('').max(50),
    lastName: Joi.string().trim().allow('').max(50),
    cityId: objectId.allow(null, ''),
  })),
  async (req, res, next) => {
    try {
      const phone = normalizePhone(req.body.phone);
      if (!phone) throw new AppError('VALIDATION_ERROR', 'Telefon nömrəsi düzgün deyil', 400);
      if (await User.findOne({ phone })) throw new AppError('PHONE_TAKEN', 'Bu nömrə artıq qeydiyyatdadır', 409);
      const city = req.body.cityId ? await cityService.requireActiveCity(req.body.cityId) : null;
      const user = await User.create({
        role: 'ADMIN',
        phone,
        phoneVerified: true,
        passwordHash: await User.hashPassword(req.body.password),
        firstName: req.body.firstName || '',
        lastName: req.body.lastName || '',
        adminCityId: city ? city._id : null,
      });
      await audit(req, 'ADMIN_CREATE', 'User', user._id, null, { phone, cityId: city ? city._id : null });
      ok(res, { admin: publicUser(user) }, {}, 201);
    } catch (e) { next(e); }
  }
);

router.patch(
  '/admins/:id',
  requireSuperAdmin,
  validated(Joi.object({
    cityId: objectId.allow(null, ''),
    isActive: Joi.boolean(),
    password: Joi.string().min(8).max(100),
    firstName: Joi.string().trim().allow('').max(50),
    lastName: Joi.string().trim().allow('').max(50),
  })),
  async (req, res, next) => {
    try {
      const user = await User.findOne({ _id: req.params.id, role: 'ADMIN' });
      if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      const isSelf = String(user._id) === String(req.user._id);
      if (isSelf && (req.body.isActive === false || req.body.cityId)) {
        throw new AppError('FORBIDDEN', 'Öz hesabınızı bağlaya və ya regional edə bilməzsiniz', 403);
      }
      if (req.body.cityId !== undefined) {
        user.adminCityId = req.body.cityId ? (await cityService.requireActiveCity(req.body.cityId))._id : null;
      }
      if (req.body.isActive !== undefined) user.isActive = req.body.isActive;
      if (req.body.firstName !== undefined) user.firstName = req.body.firstName;
      if (req.body.lastName !== undefined) user.lastName = req.body.lastName;
      if (req.body.password) user.passwordHash = await User.hashPassword(req.body.password);
      await user.save();
      await audit(req, 'ADMIN_UPDATE', 'User', user._id, null, { ...req.body, password: req.body.password ? '***' : undefined });
      ok(res, { admin: publicUser(user) });
    } catch (e) { next(e); }
  }
);

// ---- Sərnişinlər: admin.extra.routes.js ----

// ---- Müştəri rəyləri (reytinq və şikayət) — regional admin öz şəhərinin sürücüləri üzrə ----

/** Reytinqlər: ?maxScore=3 (yalnız aşağı), ?withComment=1, ?driverId=, ?page= */
router.get('/ratings', async (req, res, next) => {
  try {
    const q = {};
    if (req.query.driverId) q.driverId = (await loadDriverInScope(req, req.query.driverId, { allowDeleted: true }))._id;
    else {
      const ids = await scopedDriverIds(req);
      if (ids) q.driverId = { $in: ids };
    }
    if (req.query.maxScore) q.score = { $lte: Number(req.query.maxScore) || 5 };
    if (req.query.withComment === '1') q.comment = { $nin: [null, ''] };
    const { skip, limit, page } = views.paging(req.query, 30);
    const [docs, total] = await Promise.all([
      Rating.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Rating.countDocuments(q),
    ]);
    const [drivers, customers] = await Promise.all([
      views.driverInfoMap(docs.map((r) => r.driverId)),
      views.customerInfoMap(docs.map((r) => r.customerId)),
    ]);
    ok(res, {
      ratings: docs.map((r) => ({ ...r, driver: drivers.get(String(r.driverId)) || null, customer: customers.get(String(r.customerId)) || null })),
      total,
      page,
      limit,
    });
  } catch (e) { next(e); }
});

/** Şikayətlər: ?status=OPEN|IN_REVIEW|RESOLVED|REJECTED... */
router.get('/complaints', async (req, res, next) => {
  try {
    const q = {};
    const ids = await scopedDriverIds(req);
    if (ids) q.driverId = { $in: ids };
    if (req.query.status) q.status = String(req.query.status);
    const { skip, limit, page } = views.paging(req.query, 30);
    const [docs, total] = await Promise.all([
      Complaint.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Complaint.countDocuments(q),
    ]);
    const [drivers, customers] = await Promise.all([
      views.driverInfoMap(docs.map((c) => c.driverId)),
      views.customerInfoMap(docs.map((c) => c.customerId)),
    ]);
    ok(res, {
      complaints: docs.map((c) => ({ ...c, driver: c.driverId ? drivers.get(String(c.driverId)) || null : null, customer: customers.get(String(c.customerId)) || null })),
      total,
      page,
      limit,
    });
  } catch (e) { next(e); }
});

router.patch(
  '/complaints/:id',
  validated(Joi.object({
    status: Joi.string().valid('OPEN', 'IN_REVIEW', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_DRIVER', 'RESOLVED', 'REJECTED'),
    adminNotes: Joi.string().allow('').max(2000),
  })),
  async (req, res, next) => {
    try {
      const c = await Complaint.findById(views.oid(req.params.id));
      if (!c) throw new AppError('NOT_FOUND', 'Complaint not found', 404);
      if (!scopeOf(req).isSuper) {
        if (!c.driverId) throw new AppError('NOT_FOUND', 'Complaint not found', 404);
        await loadDriverInScope(req, c.driverId, { allowDeleted: true });
      }
      if (req.body.status !== undefined) c.status = req.body.status;
      if (req.body.adminNotes !== undefined) c.adminNotes = req.body.adminNotes;
      await c.save();
      await audit(req, 'COMPLAINT_UPDATE', 'Complaint', c._id, null, req.body);
      ok(res, { complaint: c });
    } catch (e) { next(e); }
  }
);

// ---- Tariflər, promo kodlar, ayarlar ----
router.get('/pricing-rules', requireSuperAdmin, async (req, res) => {
  ok(res, { rules: await PricingRule.find() });
});

router.post('/pricing-rules', requireSuperAdmin, async (req, res, next) => {
  try {
    const rule = await PricingRule.create(req.body);
    await audit(req, 'PRICING_CREATE', 'PricingRule', rule._id, null, rule.toObject());
    ok(res, { rule }, {}, 201);
  } catch (e) { next(e); }
});

router.patch('/pricing-rules/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const rule = await PricingRule.findById(req.params.id);
    if (!rule) throw new AppError('NOT_FOUND', 'Pricing rule not found', 404);
    Object.assign(rule, req.body);
    rule.version += 1;
    await rule.save();
    await audit(req, 'PRICING_UPDATE', 'PricingRule', rule._id, null, rule.toObject());
    ok(res, { rule });
  } catch (e) { next(e); }
});

router.get('/promo-codes', requireSuperAdmin, async (req, res) => {
  ok(res, { promos: await PromoCode.find() });
});

router.post('/promo-codes', requireSuperAdmin, async (req, res, next) => {
  try {
    const promo = await PromoCode.create({ ...req.body, code: String(req.body.code).toUpperCase() });
    await audit(req, 'PROMO_CREATE', 'PromoCode', promo._id, null, promo.toObject());
    ok(res, { promo }, {}, 201);
  } catch (e) { next(e); }
});

router.patch('/promo-codes/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const promo = await PromoCode.findByIdAndUpdate(req.params.id, req.body, { new: true });
    ok(res, { promo });
  } catch (e) { next(e); }
});

router.get('/settings', requireSuperAdmin, async (req, res) => {
  ok(res, { settings: await getSettings() });
});

router.patch('/settings', requireSuperAdmin, async (req, res, next) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await setSetting(k, v);
    }
    await audit(req, 'SETTINGS_UPDATE', 'SystemSetting', null, null, req.body);
    ok(res, { settings: await getSettings() });
  } catch (e) { next(e); }
});

// Əlavə bölmələr: sənədlər, namizəd sürücülər, sərnişinlər, canlı xəritə, hesabatlar, jurnal
router.use(require('./admin.extra.routes'));

module.exports = router;
