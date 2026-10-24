const router = require('express').Router();
const { ok, AppError } = require('../utils/errors');
const appVersion = require('../services/appVersion.service');

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

module.exports = router;
