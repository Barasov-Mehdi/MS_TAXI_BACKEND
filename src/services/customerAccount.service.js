const { Customer, User, Order, SavedPlace, ScheduledRide, RefreshToken, AuditLog } = require('../models');
const { AppError } = require('../utils/errors');
const { isActive } = require('../utils/orderStatus');
const avatarService = require('./avatar.service');

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
    await avatarService.removeByUrl(u.avatarUrl).catch(() => {});
    u.avatarUrl = null;
    u.avatarKey = null;
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

// ---------------------------------------------------------------- Saytdan silmə (Google Play tələbi)
// Tətbiqi artıq silmiş istifadəçi də hesabını silə bilsin: sayt → nömrə → SMS kod → təsdiq.
// Giriş (login) edilmir, yeni hesab yaranmır, telefondakı tətbiqin sessiyası da ləğv olunur.

async function findCustomerByPhone(phone) {
  // eslint-disable-next-line global-require
  const { normalizePhone } = require('../utils/validators');
  const p = normalizePhone(phone);
  if (!p) throw new AppError('VALIDATION_ERROR', 'Telefon nömrəsi düzgün deyil', 400);
  const user = await User.findOne({ phone: p, role: 'CUSTOMER' });
  const customer = user ? await Customer.findOne({ userId: user._id }) : null;
  return { phone: p, user, customer };
}

/**
 * Kod göndərilir yalnız aktiv sərnişin hesabı varsa. Cavab hər halda eynidir
 * ("hesab varsa SMS göndərildi") — nömrənin qeydiyyatda olub-olmadığı bilinməsin.
 */
async function requestWebDeletion(phone) {
  // eslint-disable-next-line global-require
  const otpService = require('./otp.service');
  const { phone: p, user, customer } = await findCustomerByPhone(phone);
  if (user && user.isActive !== false && customer && !customer.deletedAt) {
    const r = await otpService.requestOtp(p, 'delete');
    return { sent: true, ...(r && r.devCode ? { devCode: r.devCode } : {}) };
  }
  return { sent: true };
}

async function confirmWebDeletion({ phone, code, reason = '', ip = null }) {
  // eslint-disable-next-line global-require
  const otpService = require('./otp.service');
  const { phone: p, user, customer } = await findCustomerByPhone(phone);
  // Kod həmişə yoxlanılır (hesab olmasa da) — cavabdan nömrənin varlığı bilinməsin
  await otpService.verifyOtp(p, code, 'delete');
  if (!user || !customer) throw new AppError('ACCOUNT_NOT_FOUND', 'Bu nömrə ilə hesab tapılmadı', 404);
  if (customer.deletedAt) return { deleted: true };
  return deleteCustomerAccount({ user, customer, reason: `[sayt] ${String(reason || '').trim()}`.trim(), ip });
}

module.exports = { deleteCustomerAccount, requestWebDeletion, confirmWebDeletion };
