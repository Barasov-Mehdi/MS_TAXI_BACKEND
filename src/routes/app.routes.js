const router = require('express').Router();
const { ok, AppError } = require('../utils/errors');
const appVersion = require('../services/appVersion.service');
const newsImages = require('../services/newsImage.service');

/**
 * Tətbiq versiyası (giriş tələb etmir: məcburi yeniləmə login ekranında da işləməlidir).
 *   GET /app/version?app=driver&platform=android&versionCode=4
 */
router.get('/version', async (req, res, next) => {
  try {
    const app = String(req.query.app || 'driver');
    const platform = String(req.query.platform || 'android');
    if (app !== 'driver' || platform !== 'android') {
      throw new AppError('NOT_SUPPORTED', 'Bu tətbiq/platforma üçün versiya məlumatı yoxdur', 404);
    }
    res.set('Cache-Control', 'no-store');
    ok(res, await appVersion.check({ versionCode: req.query.versionCode }));
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
