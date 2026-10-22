const router = require('express').Router();
const mongoose = require('mongoose');
const Joi = require('joi');
const { authenticate, requireRoles } = require('../middleware/auth');
const {
  scopeOf, requireSuperAdmin, driverFilter, loadDriverInScope, scopedDriverIds, loadOrderInScope,
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
const realtime = require('../websocket/emitter');
const {
  Order, Driver, Customer, User, Complaint, OrderIssue, City,
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

// =============================================================== Sifarişlər

router.get('/orders', async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  // Silinmiş (yumşaq) sifarişlər standart olaraq göstərilmir: ?includeDeleted=1 ilə görünür
  if (req.query.includeDeleted !== '1') q.deletedAt = null;
  // Regional admin: yalnız öz şəhərinin sürücülərinə təyin olunmuş sifarişlər
  const ids = await scopedDriverIds(req);
  if (ids) q.driverId = { $in: ids };
  else if (req.query.cityId) {
    const cityDrivers = await Driver.find(driverFilter(req)).distinct('_id');
    q.driverId = { $in: cityDrivers };
  }
  const orders = await Order.find(q).sort({ createdAt: -1 }).limit(100);
  ok(res, { orders });
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

/** ?cityId=<id> | none (yalnız baş admin), ?q= ad/telefon, ?online=1 */
router.get('/drivers', async (req, res, next) => {
  try {
    const q = driverFilter(req);
    if (req.query.online === '1') q.isOnline = true;
    if (req.query.q) {
      const text = String(req.query.q).trim().slice(0, 50);
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const phone = normalizePhone(text);
      const users = await User.find({
        role: 'DRIVER',
        $or: [{ firstName: rx }, { lastName: rx }, { phone: rx }, ...(phone ? [{ phone }] : [])],
      }).distinct('_id');
      q.userId = { $in: users };
    }
    const drivers = await Driver.find(q).populate('userId').populate('cityId', 'name').sort({ createdAt: -1 }).limit(200);
    ok(res, { drivers });
  } catch (e) { next(e); }
});

router.get('/drivers/:id', async (req, res, next) => {
  try {
    const driver = await loadDriverInScope(req, req.params.id);
    await driver.populate('userId');
    await driver.populate('cityId', 'name');
    ok(res, { driver });
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
      const q = driverFilter(req);
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
    ok(res, { transactions: await WalletTransaction.find(q).sort({ createdAt: -1 }).limit(200) });
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

router.post('/drivers/:id/wallet/adjustment', async (req, res, next) => {
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

// ---- Sərnişinlər, şikayətlər ----
router.get('/customers', requireSuperAdmin, async (req, res) => {
  const customers = await Customer.find().populate('userId').limit(100);
  ok(res, { customers });
});

router.get('/complaints', requireSuperAdmin, async (req, res) => {
  ok(res, { complaints: await Complaint.find().sort({ createdAt: -1 }).limit(100) });
});

router.patch('/complaints/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const c = await Complaint.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!c) throw new AppError('NOT_FOUND', 'Complaint not found', 404);
    await audit(req, 'COMPLAINT_UPDATE', 'Complaint', c._id, null, req.body, req.body.reason);
    ok(res, { complaint: c });
  } catch (e) { next(e); }
});

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

module.exports = router;
