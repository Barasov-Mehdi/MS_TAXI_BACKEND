/**
 * Sərnişin ↔ ofis (admin) yazışması.
 *
 *  - Sərnişin tətbiqdə "Dəstək → Ofisə yazın" bölməsindən yazır. İlk mesajda mövqeyinə ən yaxın şəhər
 *    (cityService.cityForPoint) təyin olunur: həmin şəhərin regional adminləri + baş adminlər görür.
 *    Şəhər tapılmasa yalnız baş adminlər görür.
 *  - Admin cavab yazanda: sərnişinə socket `support_message` + push (tətbiq bağlıdırsa, ayrıca səsli kanal).
 *  - Admin panelə: socket `customer_support_message` (toast + sayğac).
 */
const mongoose = require('mongoose');
const { CustomerSupportThread, CustomerSupportMessage, Customer, User } = require('../models');
const { AppError } = require('../utils/errors');

const MAX_LEN = 1000;
const PAGE = 50;

const realtime = () => require('../websocket/emitter');
const push = () => require('./push.service');
const cities = () => require('./city.service');

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
    customerId: m.customerId,
    sender: m.sender,
    adminName: m.sender === 'ADMIN' ? m.adminName || 'Ofis' : undefined,
    text: m.text,
    clientMessageId: m.clientMessageId || undefined,
    createdAt: m.createdAt,
  };
}

async function customerSummary(customer) {
  const u = await User.findById(customer.userId).select('firstName lastName phone username').lean();
  return {
    _id: customer._id,
    name: [u && u.firstName, u && u.lastName].filter(Boolean).join(' ').trim() || (u && u.username) || '',
    phone: (u && u.phone) || '',
  };
}

async function store({ customer, sender, text, admin = null, cityId = undefined, clientMessageId = null }) {
  let msg;
  try {
    msg = await CustomerSupportMessage.create({
      customerId: customer._id,
      cityId: cityId || null,
      sender,
      adminUserId: admin ? admin._id : null,
      adminName: admin ? adminDisplayName(admin) : '',
      text,
      clientMessageId: clientMessageId || null,
    });
  } catch (e) {
    // Eyni clientMessageId ilə təkrar göndəriş (şəbəkə təkrarı): mövcud mesaj qaytarılır
    if (e && e.code === 11000 && clientMessageId) {
      const existing = await CustomerSupportMessage.findOne({ customerId: customer._id, clientMessageId });
      const thread = await CustomerSupportThread.findOne({ customerId: customer._id });
      return { msg: existing, thread, duplicate: true };
    }
    throw e;
  }
  const mine = sender === 'CUSTOMER';
  const set = {
    lastMessageAt: msg.createdAt,
    lastText: text.slice(0, 140),
    lastSender: sender,
    ...(mine ? { unreadForCustomer: 0 } : { unreadForAdmin: 0 }),
  };
  if (cityId !== undefined && cityId !== null) set.cityId = cityId;
  const thread = await CustomerSupportThread.findOneAndUpdate(
    { customerId: customer._id },
    { $set: set, $inc: mine ? { unreadForAdmin: 1 } : { unreadForCustomer: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { msg, thread };
}

// ------------------------------------------------------------------ Sərnişin tərəfi

/** Sərnişin yazır. lat/lng: şəhəri təyin etmək üçün (yalnız başlıq hələ şəhərsizdirsə istifadə olunur). */
async function sendFromCustomer(customer, text, { lat, lng, clientMessageId } = {}) {
  const t = cleanText(text);
  const existing = await CustomerSupportThread.findOne({ customerId: customer._id }).select('cityId').lean();
  let cityId = existing && existing.cityId ? existing.cityId : null;
  if (!cityId) {
    const near = await cities().cityForPoint(lat, lng).catch(() => null);
    if (near) cityId = near.id;
  }
  const { msg, thread, duplicate } = await store({ customer, sender: 'CUSTOMER', text: t, cityId, clientMessageId });
  const pub = publicMessage(msg);
  if (!duplicate) {
    realtime().toCustomer(customer._id, 'support_message', { ...pub, unread: 0 });
    realtime().toAdminCity(thread.cityId, 'customer_support_message', {
      message: pub,
      customer: await customerSummary(customer),
      cityId: thread.cityId,
      unreadForAdmin: thread.unreadForAdmin,
    });
  }
  return pub;
}

async function listMessages(customerId, { before, limit = PAGE } = {}) {
  const q = { customerId };
  if (before) {
    const d = new Date(before);
    if (!Number.isNaN(d.getTime())) q.createdAt = { $lt: d };
  }
  const n = Math.min(Math.max(Number(limit) || PAGE, 1), 100);
  const items = await CustomerSupportMessage.find(q).sort({ createdAt: -1 }).limit(n).lean();
  return { messages: items.map(publicMessage), hasMore: items.length === n };
}

async function unreadForCustomer(customerId) {
  const t = await CustomerSupportThread.findOne({ customerId }).select('unreadForCustomer').lean();
  return (t && t.unreadForCustomer) || 0;
}

async function markReadByCustomer(customerId) {
  await CustomerSupportThread.updateOne({ customerId }, { $set: { unreadForCustomer: 0 } });
}

// ------------------------------------------------------------------ Admin tərəfi

const inScope = (scope, thread) => scope.isSuper || (thread && thread.cityId && String(thread.cityId) === String(scope.cityId));

/** Admin üçün sərnişini yükləyir və səlahiyyəti yoxlayır (regional admin yalnız öz şəhərinin yazışmasını görür). */
async function loadCustomerInScope(scope, customerId) {
  if (!mongoose.isValidObjectId(String(customerId || ''))) throw new AppError('NOT_FOUND', 'Sərnişin tapılmadı', 404);
  const customer = await Customer.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Sərnişin tapılmadı', 404);
  if (!scope.isSuper) {
    const thread = await CustomerSupportThread.findOne({ customerId }).select('cityId').lean();
    if (!inScope(scope, thread)) throw new AppError('NOT_FOUND', 'Sərnişin tapılmadı', 404);
  }
  return customer;
}

async function sendFromAdmin(admin, scope, customer, text) {
  const t = cleanText(text);
  const { msg, thread } = await store({ customer, sender: 'ADMIN', text: t, admin });
  const pub = publicMessage(msg);
  realtime().toCustomer(customer._id, 'support_message', { ...pub, unread: thread.unreadForCustomer });
  // Digər adminlərin ekranında da görünsün
  realtime().toAdminCity(thread.cityId, 'customer_support_message', {
    message: pub,
    customer: { _id: customer._id },
    cityId: thread.cityId,
    unreadForAdmin: 0,
  });
  push()
    .sendToCustomer(customer._id, {
      title: pub.adminName ? `Baras · ${pub.adminName}` : 'Baras ofisi',
      body: t,
      type: 'support_message',
      tag: 'support',
      data: { messageId: String(msg._id) },
      ttlMs: 24 * 60 * 60 * 1000,
    })
    .catch((e) => console.error('[support] sərnişinə push alınmadı', e && e.message));
  return pub;
}

async function listThreads(scope, { cityId, unreadOnly = false, limit = 100 } = {}) {
  const q = { lastMessageAt: { $ne: null } };
  if (!scope.isSuper) q.cityId = new mongoose.Types.ObjectId(String(scope.cityId));
  else if (cityId === 'none') q.cityId = null;
  else if (cityId && mongoose.isValidObjectId(cityId)) q.cityId = new mongoose.Types.ObjectId(String(cityId));
  if (unreadOnly) q.unreadForAdmin = { $gt: 0 };
  const threads = await CustomerSupportThread.find(q)
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Number(limit) || 100, 200))
    .lean();
  const customers = await Customer.find({ _id: { $in: threads.map((t) => t.customerId) } })
    .select('userId')
    .populate('userId', 'firstName lastName phone username')
    .lean();
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  return threads.map((t) => {
    const c = byId.get(String(t.customerId));
    const u = c && c.userId;
    return {
      customerId: t.customerId,
      cityId: t.cityId,
      customerName: u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || '' : '',
      customerPhone: (u && u.phone) || '',
      lastMessageAt: t.lastMessageAt,
      lastText: t.lastText,
      lastSender: t.lastSender,
      unreadForAdmin: t.unreadForAdmin,
    };
  });
}

async function markReadByAdmin(customerId) {
  await CustomerSupportThread.updateOne({ customerId }, { $set: { unreadForAdmin: 0 } });
}

async function unreadForAdmin(scope) {
  const match = scope.isSuper ? {} : { cityId: new mongoose.Types.ObjectId(String(scope.cityId)) };
  const r = await CustomerSupportThread.aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: '$unreadForAdmin' } } }]);
  return (r[0] && r[0].n) || 0;
}

module.exports = {
  MAX_LEN,
  publicMessage,
  sendFromCustomer,
  listMessages,
  unreadForCustomer,
  markReadByCustomer,
  loadCustomerInScope,
  sendFromAdmin,
  listThreads,
  markReadByAdmin,
  unreadForAdmin,
};
