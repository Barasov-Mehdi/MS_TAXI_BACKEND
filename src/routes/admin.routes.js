const router = require('express').Router();
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const { getSettings, setSetting } = require('../services/settings.service');
const orderService = require('../services/order.service');
const walletService = require('../services/wallet.service');
const pushService = require('../services/push.service');
const dispatchService = require('../services/dispatch.service');
const realtime = require('../websocket/emitter');
const {
  Order, Driver, Customer, User, Complaint, OrderIssue,
  PricingRule, PromoCode, WalletTransaction, AuditLog,
} = require('../models');

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

router.get('/orders', async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  const orders = await Order.find(q).sort({ createdAt: -1 }).limit(100);
  ok(res, { orders });
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    ok(res, { order });
  } catch (e) { next(e); }
});

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const updated = await orderService.cancelOrder({ order, user: req.user, role: 'ADMIN', reason: req.body.reason });
    await audit(req, 'ORDER_CANCEL', 'Order', order._id, null, updated.status, req.body.reason);
    ok(res, { order: updated });
  } catch (e) { next(e); }
});

router.post('/orders/:id/reassign', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    const updated = await orderService.adminReassign({
      order, newDriverId: req.body.driverId, adminUser: req.user, reason: req.body.reason,
    });
    await audit(req, 'ORDER_REASSIGN', 'Order', order._id, order.driverId, req.body.driverId, req.body.reason);
    ok(res, { order: updated });
  } catch (e) { next(e); }
});

router.get('/drivers', async (req, res) => {
  const drivers = await Driver.find().populate('userId').limit(100);
  ok(res, { drivers });
});

router.patch('/drivers/:id', async (req, res, next) => {
  try {
    const driver = await Driver.findById(req.params.id);
    if (!driver) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);
    const old = driver.toObject();
    // Yalnız icazə verilən sahələr: body-dən bakiye, cari sifariş, FCM token və s. dəyişdirilə bilməz
    // (bakiye üçün /wallet/top-up və /wallet/adjustment istifadə olunur - audit və idempotency ilə).
    const ALLOWED = ['isVerified', 'isActive', 'priority', 'radiusMeters'];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) driver[key] = req.body[key];
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

router.get('/customers', async (req, res) => {
  const customers = await Customer.find().populate('userId').limit(100);
  ok(res, { customers });
});

router.get('/complaints', async (req, res) => {
  ok(res, { complaints: await Complaint.find().sort({ createdAt: -1 }).limit(100) });
});

router.patch('/complaints/:id', async (req, res, next) => {
  try {
    const c = await Complaint.findByIdAndUpdate(req.params.id, req.body, { new: true });
    await audit(req, 'COMPLAINT_UPDATE', 'Complaint', c._id, null, req.body, req.body.reason);
    ok(res, { complaint: c });
  } catch (e) { next(e); }
});

router.get('/issues', async (req, res) => {
  ok(res, { issues: await OrderIssue.find().sort({ createdAt: -1 }).limit(100) });
});

router.patch('/issues/:id', async (req, res, next) => {
  try {
    const i = await OrderIssue.findByIdAndUpdate(req.params.id, req.body, { new: true });
    ok(res, { issue: i });
  } catch (e) { next(e); }
});

router.get('/pricing-rules', async (req, res) => {
  ok(res, { rules: await PricingRule.find() });
});

router.post('/pricing-rules', async (req, res, next) => {
  try {
    const rule = await PricingRule.create(req.body);
    await audit(req, 'PRICING_CREATE', 'PricingRule', rule._id, null, rule.toObject());
    ok(res, { rule }, {}, 201);
  } catch (e) { next(e); }
});

router.patch('/pricing-rules/:id', async (req, res, next) => {
  try {
    const rule = await PricingRule.findById(req.params.id);
    Object.assign(rule, req.body);
    rule.version += 1;
    await rule.save();
    await audit(req, 'PRICING_UPDATE', 'PricingRule', rule._id, null, rule.toObject());
    ok(res, { rule });
  } catch (e) { next(e); }
});

router.get('/promo-codes', async (req, res) => {
  ok(res, { promos: await PromoCode.find() });
});

router.post('/promo-codes', async (req, res, next) => {
  try {
    const promo = await PromoCode.create({ ...req.body, code: String(req.body.code).toUpperCase() });
    await audit(req, 'PROMO_CREATE', 'PromoCode', promo._id, null, promo.toObject());
    ok(res, { promo }, {}, 201);
  } catch (e) { next(e); }
});

router.patch('/promo-codes/:id', async (req, res, next) => {
  try {
    const promo = await PromoCode.findByIdAndUpdate(req.params.id, req.body, { new: true });
    ok(res, { promo });
  } catch (e) { next(e); }
});

router.get('/settings', async (req, res) => {
  ok(res, { settings: await getSettings() });
});

router.patch('/settings', async (req, res, next) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await setSetting(k, v);
    }
    await audit(req, 'SETTINGS_UPDATE', 'SystemSetting', null, null, req.body);
    ok(res, { settings: await getSettings() });
  } catch (e) { next(e); }
});

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

router.get('/wallet-transactions', async (req, res) => {
  const q = {};
  if (req.query.driverId) q.driverId = req.query.driverId;
  ok(res, { transactions: await WalletTransaction.find(q).sort({ createdAt: -1 }).limit(200) });
});

router.post('/drivers/:id/wallet/top-up', async (req, res, next) => {
  try {
    const tx = await walletService.applyTransaction({
      driverId: req.params.id,
      type: 'TOP_UP',
      amountMinor: Number(req.body.amountMinor),
      referenceType: 'ADMIN',
      referenceId: req.user._id,
      idempotencyKey: req.headers['idempotency-key'] || `topup:${req.params.id}:${Date.now()}`,
      note: req.body.note,
      createdBy: req.user._id,
    });
    await audit(req, 'WALLET_TOPUP', 'Driver', req.params.id, null, tx.toObject());
    announceBalance(req.params.id, tx, 'TOP_UP');
    ok(res, { transaction: tx });
  } catch (e) { next(e); }
});

router.post('/drivers/:id/wallet/adjustment', async (req, res, next) => {
  try {
    const tx = await walletService.applyTransaction({
      driverId: req.params.id,
      type: 'MANUAL_ADJUSTMENT',
      amountMinor: Number(req.body.amountMinor),
      referenceType: 'ADMIN',
      referenceId: req.user._id,
      idempotencyKey: req.headers['idempotency-key'] || `adj:${req.params.id}:${Date.now()}`,
      note: req.body.note,
      createdBy: req.user._id,
    });
    await audit(req, 'WALLET_ADJUST', 'Driver', req.params.id, null, tx.toObject(), req.body.reason);
    announceBalance(req.params.id, tx, 'MANUAL_ADJUSTMENT');
    ok(res, { transaction: tx });
  } catch (e) { next(e); }
});

router.get('/audit-logs', async (req, res) => {
  ok(res, { logs: await AuditLog.find().sort({ createdAt: -1 }).limit(200) });
});

router.post('/users/:id/disable', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    user.isActive = false;
    await user.save();
    if (user.role === 'DRIVER') {
      const drv = await Driver.findOneAndUpdate(
        { userId: user._id, isOnline: true },
        { $set: { isOnline: false, onlineSince: null } },
        { new: true }
      );
      if (drv) {
        realtime.toDriver(drv._id, 'driver_offline', { reason: 'BLOCKED' });
        await dispatchService.advanceOffersOfDriver(drv._id, 'DRIVER_OFFLINE').catch(() => {});
      }
    }
    await audit(req, 'USER_DISABLE', 'User', user._id, true, false, req.body.reason);
    ok(res, { user });
  } catch (e) { next(e); }
});

module.exports = router;
