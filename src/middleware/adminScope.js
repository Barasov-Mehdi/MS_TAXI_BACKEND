const mongoose = require('mongoose');
const { Driver, Order } = require('../models');
const { AppError } = require('../utils/errors');

/**
 * Admin səlahiyyət sahəsi.
 *  - Baş admin (User.adminCityId = null): bütün şəhərlər, bütün bölmələr.
 *  - Regional admin (User.adminCityId dolu): yalnız öz şəhərinin sürücüləri, onların sifarişləri,
 *    balans əməliyyatları və yazışmaları. Ayarlar, tariflər, promo kodlar, sərnişinlər, şəhərlər, adminlər — yalnız baş admin.
 */
function scopeOf(req) {
  const cityId = req.user && req.user.adminCityId ? String(req.user.adminCityId) : null;
  return { isSuper: !cityId, cityId };
}

/** Yalnız baş admin. */
function requireSuperAdmin(req, res, next) {
  if (!scopeOf(req).isSuper) return next(new AppError('FORBIDDEN', 'Bu bölmə yalnız baş admin üçündür', 403));
  next();
}

/**
 * Sürücü sorğusu üçün filtr. Regional admin üçün həmişə öz şəhəri;
 * baş admin ?cityId= ilə süzə bilər (cityId=none → şəhəri olmayan sürücülər).
 */
function driverFilter(req, extra = {}) {
  const { isSuper, cityId } = scopeOf(req);
  if (!isSuper) return { ...extra, cityId: new mongoose.Types.ObjectId(cityId) };
  const q = req.query && req.query.cityId;
  if (q === 'none') return { ...extra, cityId: null };
  if (q && mongoose.isValidObjectId(q)) return { ...extra, cityId: new mongoose.Types.ObjectId(q) };
  return { ...extra };
}

const inScope = (req, driver) => {
  const { isSuper, cityId } = scopeOf(req);
  return isSuper || (driver && driver.cityId && String(driver.cityId) === cityId);
};

/**
 * Sürücünü yükləyir və adminin ona səlahiyyəti olduğunu yoxlayır.
 * Başqa şəhərin sürücüsü regional admin üçün "tapılmadı" kimi görünür (varlığı da sızmasın).
 */
async function loadDriverInScope(req, driverId, { allowDeleted = false } = {}) {
  if (!mongoose.isValidObjectId(String(driverId || ''))) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);
  const driver = await Driver.findById(driverId);
  if (!driver || !inScope(req, driver)) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);
  // Silinmiş sürücü üzərində əməliyyat olmaz (yalnız baxış: allowDeleted)
  if (driver.deletedAt && !allowDeleted) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);
  return driver;
}

/** Regional admin üçün: öz şəhərindəki sürücülərin id-ləri (sifariş/tranzaksiya süzgəci üçün). */
async function scopedDriverIds(req) {
  const { isSuper } = scopeOf(req);
  if (isSuper) return null; // null → məhdudiyyət yoxdur
  return Driver.find(driverFilter(req)).distinct('_id');
}

/**
 * Sifarişi yükləyir; regional admin yalnız öz şəhərinin sürücüsünə təyin olunmuş sifarişə müdaxilə edə bilər.
 */
async function loadOrderInScope(req, orderId) {
  if (!mongoose.isValidObjectId(String(orderId || ''))) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  if (scopeOf(req).isSuper) return order;
  if (!order.driverId) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  const n = await Driver.countDocuments(driverFilter(req, { _id: order.driverId }));
  if (!n) throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  return order;
}

module.exports = { scopeOf, requireSuperAdmin, driverFilter, inScope, loadDriverInScope, scopedDriverIds, loadOrderInScope };
