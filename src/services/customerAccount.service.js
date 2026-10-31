const { Customer, User, Order, SavedPlace, ScheduledRide, RefreshToken, AuditLog } = require('../models');
const { AppError } = require('../utils/errors');
const { isActive } = require('../utils/orderStatus');

/**
 * Müştəri hesabını SİL (müştərinin öz istəyi ilə; Google Play "hesabı silmə" tələbi).
 *
 * Sürücü silinməsi (driverAdmin.softDeleteDriver) ilə eyni prinsip — yumşaq silmə:
 *  - Sifariş, reytinq, şikayət və qazanc qeydləri QALIR (sürücülərin tarixçəsi və hesabatlar pozulmur),
 *    amma onlar artıq şəxsi məlumatsız hesaba bağlıdır.
 *  - Şəxsi məlumatlar silinir: ad, soyad, email, istifadəçi adı, avatar, cihaz tokeni, son məkan.
 *  - Saxlanmış ünvanlar və planlı sifarişlər tamamilə silinir.
 *  - Telefon nömrəsi azad edilir (eyni nömrə ilə yeni hesab açmaq mümkündür); əsli User.deletedPhone-da
 *    saxlanılır (sürücü silinməsində olduğu kimi — saxtakarlıq / hüquqi sorğular üçün).
 *  - Bütün sessiyalar (refresh token) ləğv olunur, hesab bağlanır (isActive = false).
 *  - Aktiv sifarişi olan müştəri silinmir (409 ACTIVE_ORDER).
 *  - AuditLog: CUSTOMER_ACCOUNT_DELETED (+ müştərinin yazdığı səbəb).
 */
async function deleteCustomerAccount({ user, customer, reason = '', ip = null }) {
  if (!user || !customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found', 404);
  if (customer.deletedAt) throw new AppError('ACCOUNT_DELETED', 'Hesab artıq silinib', 410);

  // Aktiv sifariş: səfər bitməli və ya ləğv olunmalıdır
  const recent = await Order.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(20).select('status').lean();
  if (recent.some((o) => isActive(o.status))) {
    throw new AppError('ACTIVE_ORDER', 'Aktiv sifarişiniz var. Əvvəlcə səfəri bitirin və ya sifarişi ləğv edin', 409);
  }

  const stamp = Date.now();

  await SavedPlace.deleteMany({ customerId: customer._id });
  await ScheduledRide.deleteMany({ customerId: customer._id });

  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        deletedAt: new Date(),
        fcmToken: null,
        fcmTokenUpdatedAt: null,
        location: { type: 'Point', coordinates: [0, 0] },
        locationUpdatedAt: null,
      },
    }
  );

  const u = await User.findById(user._id);
  if (u) {
    if (!u.deletedPhone) u.deletedPhone = u.phone;
    u.phone = `deleted:${stamp}:${u.deletedPhone}`;
    u.firstName = '';
    u.lastName = '';
    u.email = null;
    u.username = undefined;
    u.usernameLower = undefined;
    u.avatarUrl = null;
    u.phoneVerifyCode = null;
    u.phoneVerifyExpiresAt = null;
    u.activeSessionId = null;
    u.isActive = false;
    await u.save();
  }

  await RefreshToken.deleteMany({ userId: user._id }).catch(() => {});

  await AuditLog.create({
    actorId: user._id,
    actorRole: 'CUSTOMER',
    action: 'CUSTOMER_ACCOUNT_DELETED',
    entityType: 'Customer',
    entityId: customer._id,
    reason: String(reason || '').trim().slice(0, 300) || undefined,
    ip: ip || undefined,
  }).catch(() => {});

  return { deleted: true };
}

module.exports = { deleteCustomerAccount };
