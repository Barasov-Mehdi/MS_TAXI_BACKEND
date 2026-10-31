const router = require('express').Router();
const { ok, AppError } = require('../utils/errors');
const appVersion = require('../services/appVersion.service');
const newsImages = require('../services/newsImage.service');
const avatarImages = require('../services/avatar.service');
const maintenance = require('../services/maintenance.service');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const customerAccount = require('../services/customerAccount.service');

const limiter = (max) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: true },
  handler: (req, res, next) => next(new AppError('TOO_MANY_REQUESTS', 'Çox sorğu göndərildi, bir az sonra yenidən cəhd edin', 429)),
});
const deletionRequestLimiter = limiter(6);
const deletionConfirmLimiter = limiter(20);

function body(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body || {}, { stripUnknown: true });
    if (error) return next(new AppError('VALIDATION_ERROR', error.details[0].message, 400));
    req.body = value;
    return next();
  };
}
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * İstəyə bağlı giriş: Authorization başlığı varsa və müştəri tokenidirsə, cihazın versiyası yadda saxlanılır
 * (köhnə versiyalı müştərilərə "Yeni versiya" bildirişi üçün). Token yoxdur / etibarsızdır → səssiz keçilir.
 */
async function rememberCaller(req, app, platform) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return;
    const p = jwt.verify(h.slice(7), config.jwt.accessSecret);
    const { Customer, Driver } = require('../models');
    const v = { versionCode: req.query.versionCode, versionName: req.query.versionName, platform };
    if (app === 'customer' && p.role === 'CUSTOMER') {
      const c = await Customer.findOne({ userId: p.sub }).select('_id').lean();
      if (c) await appVersion.rememberCustomerVersion(c._id, v);
    } else if (app === 'driver' && p.role === 'DRIVER') {
      const d = await Driver.findOne({ userId: p.sub }).select('_id').lean();
      if (d) await appVersion.rememberDriverVersion(d._id, v);
    }
  } catch (_) { /* versiya yoxlaması heç vaxt xəta verməsin */ }
}

/**
 * Tətbiq versiyası (giriş tələb etmir: məcburi yeniləmə login ekranında da işləməlidir).
 *   GET /app/version?app=driver&platform=android&versionCode=4
 *   GET /app/version?app=customer&platform=android&versionCode=12&versionName=1.4.0
 *   GET /app/version?app=customer&platform=ios&versionCode=7      (iOS: CFBundleVersion)
 */
router.get('/version', async (req, res, next) => {
  try {
    const app = String(req.query.app || 'driver');
    const platform = String(req.query.platform || 'android');
    if (!appVersion.isApp(app) || !appVersion.isPlatform(platform)) {
      throw new AppError('NOT_SUPPORTED', 'Bu tətbiq/platforma üçün versiya məlumatı yoxdur', 404);
    }
    res.set('Cache-Control', 'no-store');
    rememberCaller(req, app, platform); // gözlənilmir
    ok(res, await appVersion.check({ app, platform, versionCode: req.query.versionCode }));
  } catch (e) { next(e); }
});

/**
 * Sistemin vəziyyəti (giriş tələb etmir): tətbiq açılanda və texniki işlər pəncərəsində "Yenidən yoxla" ilə.
 *   GET /app/status → { maintenance: { enabled, message, until } }
 */
router.get('/status', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    ok(res, { maintenance: await maintenance.getStatus(), serverTime: new Date().toISOString() });
  } catch (e) { next(e); }
});

/**
 * Hesabın saytdan silinməsi (girişsiz; Google Play "hesabı silmə linki" tələbi):
 *   POST /app/account-deletion/request { phone }              → { sent: true }  (hesab varsa SMS kod)
 *   POST /app/account-deletion/confirm { phone, code, reason } → { deleted: true }
 */
router.post(
  '/account-deletion/request',
  deletionRequestLimiter,
  body(Joi.object({ phone: Joi.string().trim().max(30).required().messages({ 'any.required': 'Telefon nömrəsini yazın', 'string.empty': 'Telefon nömrəsini yazın' }) })),
  async (req, res, next) => {
    try {
      ok(res, await customerAccount.requestWebDeletion(req.body.phone));
    } catch (e) { next(e); }
  }
);

router.post(
  '/account-deletion/confirm',
  deletionConfirmLimiter,
  body(Joi.object({
    phone: Joi.string().trim().max(30).required(),
    code: Joi.string().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'Kod 6 rəqəmdən ibarət olmalıdır', 'any.required': 'SMS kodu yazın' }),
    reason: Joi.string().trim().allow('').max(300),
  })),
  async (req, res, next) => {
    try {
      ok(res, await customerAccount.confirmWebDeletion({ ...req.body, ip: req.ip }));
    } catch (e) { next(e); }
  }
);

/**
 * "Yeniliklər" şəkilləri (giriş tələb etmir). server.js-də rate-limit-dən ƏVVƏL qoşulur:
 * operatorun CGNAT-ında eyni IP-dən çoxlu sürücü şəkil yükləyəndə limitə düşməsin.
 */
const images = require('express').Router();
images.get('/:id', async (req, res, next) => {
  try {
    await newsImages.stream(req.params.id, res);
  } catch (e) { next(e); }
});

/** Profil şəkilləri (giriş tələb etmir): GET /app/avatars/:id */
const avatars = require('express').Router();
avatars.get('/:id', async (req, res, next) => {
  try {
    await avatarImages.stream(req.params.id, res);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.images = images;
module.exports.avatars = avatars;
