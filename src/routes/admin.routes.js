const router = require('express').Router();
const { authenticate, requireRoles } = require('../middleware/auth');
const { ok, AppError } = require('../utils/errors');
const { getSettings, setSetting } = require('../services/settings.service');
const orderService = require('../services/order.service');
const walletService = require('../services/wallet.service');
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
    Object.assign(driver, req.body);
    await driver.save();
    await audit(req, 'DRIVER_UPDATE', 'Driver', driver._id, old, driver.toObject(), req.body.reason);
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
    ok(res, { transaction: tx });
  } catch (e) { next(e); }
});

router.get('/audit-logs', async (req, res) => {
  ok(res, { logs: await AuditLog.find().sort({ createdAt: -1 }).limit(200) });
});

router.post('/users/:id/disable', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    user.isActive = false;
    await user.save();
    await audit(req, 'USER_DISABLE', 'User', user._id, true, false, req.body.reason);
    ok(res, { user });
  } catch (e) { next(e); }
});

module.exports = router;
