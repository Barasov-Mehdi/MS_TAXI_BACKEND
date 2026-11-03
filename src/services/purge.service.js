/**
 * TAM SİLMƏ (hard delete) — yalnız baş admin.
 *
 * Yumşaq silmədən (driverAdmin.softDeleteDriver / customerAccount.deleteCustomerAccount) fərqli olaraq
 * şəxsin bütün məlumatları verilənlər bazasından birdəfəlik silinir. GERİ QAYTARILMIR.
 *
 * Sürücü üçün silinənlər:
 *   Driver, User, Vehicle, DriverDocument (+ GridFS şəkillər), avatar, SupportThread/SupportMessage,
 *   WalletTransaction, TripEarning, DriverDeleteRequest, Rating, Complaint, Notification, RefreshToken,
 *   OtpCode, sifariş çatı mesajları (göndərdiyi/aldığı), OrderIssue (yazdığı).
 * Müştəri üçün silinənlər:
 *   Customer, User, avatar, SavedPlace, ScheduledRide, PromoUsage, CustomerSupportThread/Message,
 *   Rating, Complaint, Notification, RefreshToken, OtpCode, sifariş çatı mesajları, OrderIssue.
 *
 * Sifarişlər (iki tərəfə aiddir):
 *   withOrders = false (standart): sifarişlər qalır, amma şəxsdən ayrılır
 *     - sürücü: driverId / currentOfferDriverId = null, təklif siyahılarından çıxarılır;
 *     - müştəri: "başqası üçün" ad/telefon təmizlənir (customerId boş hesaba işarə edir).
 *     Qarşı tərəfin tarixçəsi və hesabatlar pozulmur.
 *   withOrders = true: şəxsin bütün sifarişləri və onlara bağlı hər şey (status tarixçəsi, çat, şikayət,
 *     reytinq, problem bildirişi, qazanc qeydi) də silinir.
 *
 * Aktiv sifarişi olan şəxs silinmir (409). AuditLog-a yalnız "kim, nə vaxt, hansı id" yazılır (şəxsi məlumat yox).
 */
const mongoose = require('mongoose');
const {
  User, Customer, Driver, Vehicle, Order, OrderStatusHistory, Message, Rating, Complaint, OrderIssue,
  WalletTransaction, PromoUsage, RefreshToken, OtpCode, Notification, AuditLog, TripEarning,
  SupportThread, SupportMessage, DriverDeleteRequest, DriverDocument, CustomerSupportThread,
  CustomerSupportMessage, SavedPlace, ScheduledRide,
} = require('../models');
const { AppError } = require('../utils/errors');
const { isActive } = require('../utils/orderStatus');
const realtime = require('../websocket/emitter');
const avatarService = require('./avatar.service');

const oid = (id) => {
  if (!mongoose.isValidObjectId(String(id || ''))) return null;
  return new mongoose.Types.ObjectId(String(id));
};

/** Həm aktiv, həm "deleted:..." formalı nömrələr (OTP kodlarını silmək üçün). */
function phonesOf(user) {
  return [user && user.phone, user && user.deletedPhone].filter((p) => p && !String(p).startsWith('deleted:'));
}

function driverDocsBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'driverDocs' });
}

/** Sifarişləri və onlara bağlı bütün qeydləri silir. */
async function deleteOrdersDeep(orderIds) {
  if (!orderIds.length) return 0;
  const q = { orderId: { $in: orderIds } };
  await Promise.all([
    OrderStatusHistory.deleteMany(q),
    Message.deleteMany(q),
    Rating.deleteMany(q),
    Complaint.deleteMany(q),
    OrderIssue.deleteMany(q),
    TripEarning.deleteMany(q),
    PromoUsage.deleteMany(q),
  ]);
  // Dayandırılmış səfər ↔ davam sifarişi əlaqəsi qırılmasın deyə qalan sifarişlərdə təmizlənir
  await Order.updateMany({ continuedToOrderId: { $in: orderIds } }, { $set: { continuedToOrderId: null } });
  await Order.updateMany({ continuedFromOrderId: { $in: orderIds } }, { $set: { continuedFromOrderId: null } });
  const r = await Order.deleteMany({ _id: { $in: orderIds } });
  return r.deletedCount || 0;
}

async function assertNoActiveOrder(filter, code, text) {
  const rows = await Order.find(filter).sort({ createdAt: -1 }).limit(50).select('status').lean();
  if (rows.some((o) => isActive(o.status))) throw new AppError(code, text, 409);
}

async function writeAudit(admin, entityType, entityId, summary, reason, ip) {
  await AuditLog.create({
    actorId: admin ? admin._id : null,
    actorRole: 'ADMIN',
    action: `${entityType.toUpperCase()}_PURGE`,
    entityType,
    entityId,
    newValue: summary,
    reason: String(reason || '').trim().slice(0, 300) || undefined,
    ip: ip || undefined,
  }).catch(() => {});
}

// ================================================================ Sürücü

async function purgeDriver(driverId, { admin = null, withOrders = false, reason = '', ip = null } = {}) {
  const id = oid(driverId);
  if (!id) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);
  const driver = await Driver.findById(id).lean();
  if (!driver) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);

  await assertNoActiveOrder(
    { driverId: id },
    'DRIVER_BUSY',
    'Sürücünün aktiv sifarişi var. Sifariş bitəndən sonra silin'
  );

  const user = driver.userId ? await User.findById(driver.userId).lean() : null;
  const userId = user ? user._id : driver.userId || null;

  // Açıq tətbiq dərhal çıxış etsin
  realtime.toDriver(id, 'driver_offline', { reason: 'BLOCKED' });
  if (realtime.disconnectRoom) {
    realtime.disconnectRoom(`driver:${id}`);
    if (userId) realtime.disconnectRoom(`driver:${userId}`);
  }

  // Sifarişlər
  const orderIds = await Order.find({ driverId: id }).distinct('_id');
  let ordersDeleted = 0;
  if (withOrders) {
    ordersDeleted = await deleteOrdersDeep(orderIds);
  } else {
    await Order.updateMany({ driverId: id }, { $set: { driverId: null } });
  }
  await Order.updateMany({ currentOfferDriverId: id }, { $set: { currentOfferDriverId: null } });
  await Order.updateMany(
    { $or: [{ offeredToDriverIds: id }, { rejectedDriverIds: id }] },
    { $pull: { offeredToDriverIds: id, rejectedDriverIds: id } }
  );

  // Sənəd şəkilləri (GridFS)
  const docs = await DriverDocument.find({ driverId: id }).select('fileId').lean();
  const bucket = docs.length ? driverDocsBucket() : null;
  for (const d of docs) {
    if (d.fileId) await bucket.delete(d.fileId).catch(() => {});
  }

  // Sürücüyə aid qeydlər
  await Promise.all([
    DriverDocument.deleteMany({ driverId: id }),
    Vehicle.deleteMany({ driverId: id }),
    SupportMessage.deleteMany({ driverId: id }),
    SupportThread.deleteMany({ driverId: id }),
    WalletTransaction.deleteMany({ driverId: id }),
    TripEarning.deleteMany({ driverId: id }),
    DriverDeleteRequest.deleteMany({ driverId: id }),
    Rating.deleteMany({ driverId: id }),
    Complaint.deleteMany({ driverId: id }),
  ]);

  // İstifadəçi hesabına aid qeydlər
  if (userId) {
    await Promise.all([
      Message.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }] }),
      OrderIssue.deleteMany({ reporterUserId: userId }),
      Notification.deleteMany({ userId }),
      RefreshToken.deleteMany({ userId }),
    ]);
  }
  const phones = phonesOf(user);
  if (phones.length) await OtpCode.deleteMany({ phone: { $in: phones } });
  if (user && user.avatarUrl) await avatarService.removeByUrl(user.avatarUrl).catch(() => {});

  await Driver.deleteOne({ _id: id });
  if (userId) await User.deleteOne({ _id: userId });

  const summary = { withOrders: !!withOrders, orders: orderIds.length, ordersDeleted, documents: docs.length };
  await writeAudit(admin, 'Driver', id, summary, reason, ip);
  realtime.toAdmin('driver_purged', { driverId: String(id) });
  return { purged: true, ...summary };
}

// ================================================================ Müştəri

async function purgeCustomer(customerId, { admin = null, withOrders = false, reason = '', ip = null } = {}) {
  const id = oid(customerId);
  if (!id) throw new AppError('CUSTOMER_NOT_FOUND', 'Müştəri tapılmadı', 404);
  const customer = await Customer.findById(id).lean();
  if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Müştəri tapılmadı', 404);

  await assertNoActiveOrder(
    { customerId: id },
    'ACTIVE_ORDER',
    'Müştərinin aktiv sifarişi var. Səfər bitəndən və ya ləğv olunandan sonra silin'
  );

  const user = customer.userId ? await User.findById(customer.userId).lean() : null;
  const userId = user ? user._id : customer.userId || null;

  realtime.toCustomer(id, 'account_blocked', { reason: 'DELETED' });
  if (realtime.disconnectRoom) {
    const room = `customer:${id}`;
    setTimeout(() => realtime.disconnectRoom(room), 800).unref();
  }

  // Sifarişlər
  const orderIds = await Order.find({ customerId: id }).distinct('_id');
  let ordersDeleted = 0;
  if (withOrders) {
    ordersDeleted = await deleteOrdersDeep(orderIds);
  } else {
    await Order.updateMany(
      { customerId: id },
      { $set: { 'passenger.name': '', 'passenger.phone': '', idempotencyKey: null } }
    );
  }

  // Müştəriyə aid qeydlər
  await Promise.all([
    SavedPlace.deleteMany({ customerId: id }),
    ScheduledRide.deleteMany({ customerId: id }),
    PromoUsage.deleteMany({ customerId: id }),
    CustomerSupportMessage.deleteMany({ customerId: id }),
    CustomerSupportThread.deleteMany({ customerId: id }),
    Rating.deleteMany({ customerId: id }),
    Complaint.deleteMany({ customerId: id }),
  ]);

  if (userId) {
    await Promise.all([
      Message.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }] }),
      OrderIssue.deleteMany({ reporterUserId: userId }),
      Notification.deleteMany({ userId }),
      RefreshToken.deleteMany({ userId }),
    ]);
  }
  const phones = phonesOf(user);
  if (phones.length) await OtpCode.deleteMany({ phone: { $in: phones } });
  if (user && user.avatarUrl) await avatarService.removeByUrl(user.avatarUrl).catch(() => {});

  await Customer.deleteOne({ _id: id });
  if (userId) await User.deleteOne({ _id: userId });

  const summary = { withOrders: !!withOrders, orders: orderIds.length, ordersDeleted };
  await writeAudit(admin, 'Customer', id, summary, reason, ip);
  realtime.toAdmin('customer_purged', { customerId: String(id) });
  return { purged: true, ...summary };
}

module.exports = { purgeDriver, purgeCustomer };
