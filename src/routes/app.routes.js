const router = require('express').Router();
const { ok, AppError } = require('../utils/errors');
const appVersion = require('../services/appVersion.service');
const newsImages = require('../services/newsImage.service');
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * İstəyə bağlı giriş: Authorization başlığı varsa və müştəri tokenidirsə, cihazın versiyası yadda saxlanılır
 * (köhnə versiyalı müştərilərə "Yeni versiya" bildirişi üçün). Token yoxdur / etibarsızdır → səssiz keçilir.
 */
async function rememberCaller(req, app) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return;
    const p = jwt.verify(h.slice(7), config.jwt.accessSecret);
    const { Customer, Driver } = require('../models');
    const v = { versionCode: req.query.versionCode, versionName: req.query.versionName };
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
 */
router.get('/version', async (req, res, next) => {
  try {
    const app = String(req.query.app || 'driver');
    const platform = String(req.query.platform || 'android');
    if (!appVersion.isApp(app) || platform !== 'android') {
      throw new AppError('NOT_SUPPORTED', 'Bu tətbiq/platforma üçün versiya məlumatı yoxdur', 404);
    }
    res.set('Cache-Control', 'no-store');
    rememberCaller(req, app); // gözlənilmir
    ok(res, await appVersion.check({ app, versionCode: req.query.versionCode }));
  } catch (e) { next(e); }
});

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

module.exports = router;
module.exports.images = images;
