const { Driver, User, Vehicle, RefreshToken, Order } = require('../models');
const { AppError } = require('../utils/errors');
const { isActive } = require('../utils/orderStatus');
const dispatchService = require('./dispatch.service');
const realtime = require('../websocket/emitter');

/**
 * Sürücünü SİL (yumşaq): sənədlər qalır (sifariş, qazanc, balans tarixçəsi pozulmur), amma
 *  - hesab bağlanır, bütün sessiyalar ləğv olunur;
 *  - telefon nömrəsi və avtomobil nömrə nişanı azad edilir (yenidən qeydiyyat mümkün olsun);
 *  - admin siyahılarında görünmür.
 * Aktiv sifarişi olan sürücü silinmir.
 */
async function softDeleteDriver(driverId, adminUser) {
  const driver = await Driver.findById(driverId);
  if (!driver || driver.deletedAt) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);

  if (driver.currentOrderId) {
    const cur = await Order.findById(driver.currentOrderId).select('status').lean();
    if (cur && isActive(cur.status)) {
      throw new AppError('DRIVER_BUSY', 'Sürücünün aktiv sifarişi var. Sifariş bitəndən sonra silin', 409);
    }
  }

  const stamp = Date.now();
  driver.isOnline = false;
  driver.onlineSince = null;
  driver.isActive = false;
  driver.deletedAt = new Date();
  driver.deletedBy = adminUser ? adminUser._id : null;
  driver.fcmToken = null;
  await driver.save();

  const user = await User.findById(driver.userId);
  if (user) {
    if (!user.deletedPhone) user.deletedPhone = user.phone;
    user.phone = `deleted:${stamp}:${user.deletedPhone}`;
    user.isActive = false;
    await user.save();
    await RefreshToken.deleteMany({ userId: user._id }).catch(() => {});
  }

  await Vehicle.updateMany(
    { driverId: driver._id, plateNumber: { $not: /#del/ } },
    [{ $set: { plateNumber: { $concat: ['$plateNumber', `#del${stamp}`] }, isActive: false } }]
  ).catch((e) => console.error('[driver-delete] vehicle', e && e.message));

  realtime.toDriver(driver._id, 'driver_offline', { reason: 'BLOCKED' });
  await dispatchService.advanceOffersOfDriver(driver._id, 'DRIVER_OFFLINE').catch(() => {});
  return driver;
}

module.exports = { softDeleteDriver };
