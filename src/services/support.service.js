const mongoose = require('mongoose');
const { SupportThread, SupportMessage, Driver, User } = require('../models');
const { AppError } = require('../utils/errors');
const realtime = require('../websocket/emitter');
const pushService = require('./push.service');

/**
 * Sürücü ↔ ofis (admin) yazışması.
 * Sürücü öz şəhərinin ofisinə yazır; həmin şəhərin regional adminləri və baş adminlər görür və cavab verir.
 * Admin istənilən (səlahiyyəti olan) sürücüyə ilk yazan da ola bilər.
 */

const MAX_LEN = 1000;
const PAGE = 50;

function cleanText(text) {
  const t = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (!t) throw new AppError('VALIDATION_ERROR', 'Mesaj boş ola bilməz', 400);
  if (t.length > MAX_LEN) throw new AppError('VALIDATION_ERROR', `Mesaj ən çox ${MAX_LEN} simvol ola bilər`, 400);
  return t;
}

const adminDisplayName = (u) => [u && u.firstName, u && u.lastName].filter(Boolean).join(' ').trim() || 'Ofis';

function publicMessage(m) {
  return {
    _id: m._id,
    driverId: m.driverId,
    sender: m.sender,
    adminName: m.sender === 'ADMIN' ? m.adminName || 'Ofis' : undefined,
    text: m.text,
    broadcast: !!m.broadcast,
    createdAt: m.createdAt,
  };
}

/** Mesajı yazır və başlığı (son mesaj, oxunmamış sayğacları) yeniləyir. */
async function store({ driver, sender, text, admin = null, broadcast = false }) {
  const msg = await SupportMessage.create({
    driverId: driver._id,
    cityId: driver.cityId || null,
    sender,
    adminUserId: admin ? admin._id : null,
    adminName: admin ? adminDisplayName(admin) : '',
    text,
    broadcast,
  });
  const inc = sender === 'DRIVER' ? { unreadForAdmin: 1 } : { unreadForDriver: 1 };
  const reset = sender === 'DRIVER' ? { unreadForDriver: 0 } : { unreadForAdmin: 0 }; // cavab yazan tərəf oxumuş sayılır
  const thread = await SupportThread.findOneAndUpdate(
    { driverId: driver._id },
    {
      $set: {
        cityId: driver.cityId || null,
        lastMessageAt: msg.createdAt,
        lastText: text.slice(0, 140),
        lastSender: sender,
        ...reset,
      },
      $inc: inc,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { msg, thread };
}

async function driverSummary(driver) {
  const u = await User.findById(driver.userId).select('firstName lastName phone').lean();
  return {
    _id: driver._id,
    name: [u && u.firstName, u && u.lastName].filter(Boolean).join(' ').trim(),
    phone: (u && u.phone) || '',
    cityId: driver.cityId || null,
  };
}

// ------------------------------------------------------------------ Sürücü tərəfi

async function sendFromDriver(driver, text) {
  const t = cleanText(text);
  const { msg, thread } = await store({ driver, sender: 'DRIVER', text: t });
  const pub = publicMessage(msg);
  realtime.toDriver(driver._id, 'support_message', pub); // sürücünün digər cihazı / ekranı üçün
  realtime.toAdminCity(driver.cityId, 'support_message', {
    message: pub,
    driver: await driverSummary(driver),
    unreadForAdmin: thread.unreadForAdmin,
  });
  return pub;
}

/** Sürücünün yazışması (yenidən köhnəyə; ?before= ilə səhifələmə). */
async function listMessages(driverId, { before, limit = PAGE } = {}) {
  const q = { driverId };
  if (before) {
    const d = new Date(before);
    if (!Number.isNaN(d.getTime())) q.createdAt = { $lt: d };
  }
  const n = Math.min(Math.max(Number(limit) || PAGE, 1), 100);
  const items = await SupportMessage.find(q).sort({ createdAt: -1 }).limit(n).lean();
  return { messages: items.map(publicMessage), hasMore: items.length === n };
}

async function unreadForDriver(driverId) {
  const t = await SupportThread.findOne({ driverId }).select('unreadForDriver').lean();
  return (t && t.unreadForDriver) || 0;
}

async function markReadByDriver(driverId) {
  await SupportThread.updateOne({ driverId }, { $set: { unreadForDriver: 0 } });
}

// ------------------------------------------------------------------ Admin tərəfi

async function sendFromAdmin(admin, driver, text, { broadcast = false, notify = true } = {}) {
  const t = cleanText(text);
  const { msg, thread } = await store({ driver, sender: 'ADMIN', text: t, admin, broadcast });
  const pub = publicMessage(msg);
  realtime.toDriver(driver._id, 'support_message', { ...pub, unread: thread.unreadForDriver });
  if (!broadcast) {
    // Digər adminlərin ekranında da görünsün (eyni şəhərin ofisi)
    realtime.toAdminCity(driver.cityId, 'support_message', { message: pub, driver: { _id: driver._id }, unreadForAdmin: 0 });
  }
  if (notify) {
    pushService
      .notifySupportMessage(driver._id, { messageId: msg._id, adminName: pub.adminName, text: t })
      .catch((e) => console.error('[push] ofis mesajı bildirişi alınmadı', e && e.message));
  }
  return pub;
}

/**
 * Başlıqlar siyahısı. filter: Driver sorğusu (regional admin üçün şəhər süzgəci) — burada yalnız cityId istifadə olunur.
 */
async function listThreads({ cityId = undefined, unreadOnly = false, limit = 100 } = {}) {
  const q = { lastMessageAt: { $ne: null } };
  if (cityId !== undefined) q.cityId = cityId;
  if (unreadOnly) q.unreadForAdmin = { $gt: 0 };
  const threads = await SupportThread.find(q)
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Number(limit) || 100, 200))
    .lean();
  const drivers = await Driver.find({ _id: { $in: threads.map((t) => t.driverId) } })
    .select('userId cityId isOnline isActive isVerified')
    .populate('userId', 'firstName lastName phone')
    .lean();
  const byId = new Map(drivers.map((d) => [String(d._id), d]));
  return threads.map((t) => {
    const d = byId.get(String(t.driverId));
    const u = d && d.userId;
    return {
      driverId: t.driverId,
      cityId: t.cityId,
      driverName: u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() : '',
      driverPhone: (u && u.phone) || '',
      isOnline: !!(d && d.isOnline),
      isActive: d ? d.isActive !== false : false,
      lastMessageAt: t.lastMessageAt,
      lastText: t.lastText,
      lastSender: t.lastSender,
      unreadForAdmin: t.unreadForAdmin,
    };
  });
}

async function markReadByAdmin(driverId) {
  await SupportThread.updateOne({ driverId }, { $set: { unreadForAdmin: 0 } });
}

/** Bir neçə sürücüyə eyni mesaj (məs. "Sabah ofis bağlıdır"). driverQuery adminin səlahiyyət süzgəcidir. */
async function broadcast(admin, driverQuery, text) {
  const t = cleanText(text);
  const drivers = await Driver.find(driverQuery).select('_id cityId').lean();
  let sent = 0;
  for (const d of drivers) {
    try {
      await sendFromAdmin(admin, d, t, { broadcast: true });
      sent += 1;
    } catch (e) {
      console.error('[support] broadcast alınmadı', String(d._id), e && e.message);
    }
  }
  return { sent, total: drivers.length };
}

const isId = (v) => mongoose.isValidObjectId(String(v || ''));

module.exports = {
  sendFromDriver,
  sendFromAdmin,
  listMessages,
  listThreads,
  unreadForDriver,
  markReadByDriver,
  markReadByAdmin,
  broadcast,
  publicMessage,
  isId,
  MAX_LEN,
};
