/**
 * Admin paneli — TAM SİLMƏ (yalnız baş admin). Geri qaytarılmır.
 *
 *  POST /admin/drivers/:id/purge     body: { confirm: "DELETE", withOrders?: boolean, reason?: string }
 *  POST /admin/customers/:id/purge   body: { confirm: "DELETE", withOrders?: boolean, reason?: string }
 *
 *  confirm   — səhvən basılmasın deyə məcburidir, dəqiq "DELETE" olmalıdır.
 *  withOrders— true: şəxsin sifarişləri və onlara bağlı hər şey də silinir;
 *              false (standart): sifarişlər qalır, şəxsdən ayrılır (qarşı tərəfin tarixçəsi pozulmur).
 *  Cavab: { purged: true, withOrders, orders, ordersDeleted, documents? }
 *  Xətalar: 403 FORBIDDEN (regional admin), 404, 409 DRIVER_BUSY / ACTIVE_ORDER, 400 VALIDATION_ERROR.
 *
 * Silinmiş (yumşaq) sürücü / müştəri də bu yolla tam silinə bilər.
 */
const router = require('express').Router();
const Joi = require('joi');
const { requireSuperAdmin } = require('../middleware/adminScope');
const { ok, AppError } = require('../utils/errors');
const purgeService = require('../services/purge.service');

const bodySchema = Joi.object({
  confirm: Joi.string().valid('DELETE').required().messages({
    'any.only': 'Təsdiq üçün "DELETE" yazın',
    'any.required': 'Təsdiq üçün "DELETE" yazın',
  }),
  withOrders: Joi.boolean().default(false),
  reason: Joi.string().trim().allow('').max(300).default(''),
});

function validated(req, res, next) {
  const { error, value } = bodySchema.validate(req.body || {}, { stripUnknown: true });
  if (error) return next(new AppError('VALIDATION_ERROR', error.details[0].message, 400));
  req.body = value;
  next();
}

router.post('/drivers/:id/purge', requireSuperAdmin, validated, async (req, res, next) => {
  try {
    const r = await purgeService.purgeDriver(req.params.id, {
      admin: req.user,
      withOrders: req.body.withOrders,
      reason: req.body.reason,
      ip: req.ip,
    });
    ok(res, r);
  } catch (e) { next(e); }
});

router.post('/customers/:id/purge', requireSuperAdmin, validated, async (req, res, next) => {
  try {
    const r = await purgeService.purgeCustomer(req.params.id, {
      admin: req.user,
      withOrders: req.body.withOrders,
      reason: req.body.reason,
      ip: req.ip,
    });
    ok(res, r);
  } catch (e) { next(e); }
});

module.exports = router;
