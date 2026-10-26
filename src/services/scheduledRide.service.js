/**
 * Planlı (avtomatik) sifarişlər.
 *
 * Müştəri marşrutu, sinfi və vaxtı seçir: birdəfəlik (tarix + saat) və ya hər həftə seçilmiş günlərdə (məs. iş günləri
 * 08:30). Vaxt çatanda sifarişi SERVER özü yaradır — müştərinin telefonu bağlı / tətbiq bağlı olsa da. Sonra adi
 * sifariş kimi sürücü axtarılır və müştəriyə push + canlı (socket) bildiriş gedir.
 *
 *  - 15 dəq əvvəl xatırlatma push-u ("sifarişiniz 08:30-da avtomatik veriləcək").
 *  - Müştərinin həmin an aktiv sifarişi varsa planlı sifariş verilmir (xəbər verilir), həftəlik plan davam edir.
 *  - Server o anda işləməyibsə (deploy və s.) 10 dəq-dən çox gecikmiş icra "buraxıldı" sayılır — gec maşın gəlməsin.
 *  - Çoxlu instansiya təhlükəsizdir: hər icra nextRunAt dəyəri ilə atomik "götürülür".
 *
 * Saat qurşağı: Azərbaycan (UTC+4, yay saatı yoxdur). SCHEDULE_UTC_OFFSET_MIN ilə dəyişdirilə bilər.
 */
const { ScheduledRide, Customer, User, Order } = require('../models');
const { AppError } = require('../utils/errors');
const { OrderStatus } = require('../utils/orderStatus');

const OFFSET_MIN = Number(process.env.SCHEDULE_UTC_OFFSET_MIN || 240);
const MIN_LEAD_MS = 5 * 60 * 1000; // birdəfəlik plan ən azı 5 dəq sonraya
const MAX_AHEAD_DAYS = 60;
const REMIND_MS = 15 * 60 * 1000;
const MISSED_MS = 10 * 60 * 1000;
const MAX_ACTIVE = 10;
const TICK_MS = Number(process.env.SCHEDULE_TICK_MS || 20000);

const orderService = () => require('./order.service');
const pricing = () => require('./pricing.service');
const realtime = () => require('../websocket/emitter');
const push = () => require('./push.service');
const notify = () => require('./customerNotify');

/* ------------------------------------------------------------------ */
/* Vaxt hesabı                                                         */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

function parseTime(time) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
  return m ? { hh: Number(m[1]), mm: Number(m[2]) } : null;
}

function parseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, mo, d };
}

/** Yerli (UTC+4) tarix/saat → UTC Date. */
function localToUtc(y, mo, d, hh, mm) {
  return new Date(Date.UTC(y, mo - 1, d, hh, mm) - OFFSET_MIN * 60000);
}

/** UTC Date → yerli hissələr. */
function utcToLocal(date) {
  const l = new Date(date.getTime() + OFFSET_MIN * 60000);
  return { y: l.getUTCFullYear(), mo: l.getUTCMonth() + 1, d: l.getUTCDate(), hh: l.getUTCHours(), mm: l.getUTCMinutes() };
}

/** ISO həftə günü: 1 = bazar ertəsi ... 7 = bazar. */
function isoWeekday(y, mo, d) {
  return ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** Növbəti icra anı (from-dan SONRA). Yoxdursa null. */
function computeNextRun(ride, from = new Date()) {
  const t = parseTime(ride.time);
  if (!t) return null;
  if (ride.repeat === 'once') {
    const dt = parseDate(ride.date);
    if (!dt) return null;
    const at = localToUtc(dt.y, dt.mo, dt.d, t.hh, t.mm);
    return at > from ? at : null;
  }
  const days = (ride.days || []).filter((n) => n >= 1 && n <= 7);
  if (!days.length) return null;
  const l = utcToLocal(from);
  for (let k = 0; k <= 7; k += 1) {
    const day = new Date(Date.UTC(l.y, l.mo - 1, l.d + k));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!days.includes(isoWeekday(y, mo, d))) continue;
    const at = localToUtc(y, mo, d, t.hh, t.mm);
    if (at > from) return at;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function toPoint(p) {
  const lat = Number(p && p.lat);
  const lng = Number(p && p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new AppError('INVALID_POINTS', 'Ünvanın koordinatı düzgün deyil', 400);
  }
  return { lat, lng, label: clip(p.label, 200), address: clip(p.address, 300) };
}

function publicRide(r) {
  return {
    id: String(r._id),
    title: r.title || '',
    pickup: r.pickup,
    stops: r.stops,
    vehicleType: r.vehicleType,
    paymentMethod: r.paymentMethod,
    repeat: r.repeat,
    date: r.date,
    days: r.days || [],
    time: r.time,
    active: !!r.active,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastOrderId: r.lastOrderId,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    createdAt: r.createdAt,
  };
}

/** Vaxt sahələrini yoxlayır və təmizlənmiş dəyərləri qaytarır. */
function parseSchedule(body, current = {}) {
  const repeat = body.repeat !== undefined ? body.repeat : current.repeat;
  if (!['once', 'weekly'].includes(repeat)) throw new AppError('INVALID_SCHEDULE', 'Təkrar növü düzgün deyil', 400);
  const time = body.time !== undefined ? String(body.time) : current.time;
  if (!parseTime(time)) throw new AppError('INVALID_SCHEDULE', 'Saat düzgün deyil (SS:dd)', 400);
  const out = { repeat, time, date: null, days: [] };
  if (repeat === 'once') {
    const date = body.date !== undefined ? body.date : current.date;
    if (!parseDate(date)) throw new AppError('INVALID_SCHEDULE', 'Tarix düzgün deyil', 400);
    out.date = date;
  } else {
    const raw = body.days !== undefined ? body.days : current.days;
    const days = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
    if (!days.length) throw new AppError('INVALID_SCHEDULE', 'Ən azı bir gün seçin', 400);
    out.days = days;
  }
  return out;
}

function assertRunnable(sched, now = new Date()) {
  const next = computeNextRun(sched, now);
  if (!next) throw new AppError('SCHEDULE_IN_PAST', 'Seçilən vaxt keçib', 400);
  if (sched.repeat === 'once') {
    if (next - now < MIN_LEAD_MS) throw new AppError('SCHEDULE_TOO_SOON', 'Ən azı 5 dəqiqə sonranı seçin', 400);
    if (next - now > MAX_AHEAD_DAYS * 86400000) throw new AppError('SCHEDULE_TOO_FAR', `Ən çox ${MAX_AHEAD_DAYS} gün sonranı seçmək olar`, 400);
  }
  return next;
}

async function list(customerId) {
  const rows = await ScheduledRide.find({ customerId }).sort({ active: -1, nextRunAt: 1, createdAt: -1 }).limit(50).lean();
  return rows.map(publicRide);
}

async function create({ customer, user }, body) {
  if (!user.username) throw new AppError('USERNAME_REQUIRED', 'Sifariş vermək üçün istifadəçi adı əlavə edin', 422);
  const pickup = toPoint(body.pickup);
  const rawStops = Array.isArray(body.stops) ? body.stops : [];
  if (!rawStops.length) throw new AppError('INVALID_POINTS', 'Təyinat seçin', 400);
  if (rawStops.length > 4) throw new AppError('TOO_MANY_STOPS', 'At most 4 stops', 400);
  const stops = rawStops.map(toPoint);
  const vehicleType = pricing().normalizeVehicleType(body.vehicleType || 'basic');
  if (!pricing().VEHICLE_TYPES.includes(vehicleType)) throw new AppError('INVALID_VEHICLE_TYPE', 'Unknown vehicle type', 400);
  const sched = parseSchedule(body);
  const nextRunAt = assertRunnable(sched);
  const activeCount = await ScheduledRide.countDocuments({ customerId: customer._id, active: true });
  if (activeCount >= MAX_ACTIVE) throw new AppError('SCHEDULE_LIMIT', `Ən çox ${MAX_ACTIVE} aktiv plan ola bilər`, 409);
  const doc = await ScheduledRide.create({
    customerId: customer._id,
    userId: user._id,
    title: clip(body.title, 40),
    pickup,
    stops,
    vehicleType,
    paymentMethod: 'CASH',
    ...sched,
    active: true,
    nextRunAt,
  });
  return publicRide(doc);
}

async function update({ customer }, id, body) {
  const doc = await ScheduledRide.findOne({ _id: id, customerId: customer._id });
  if (!doc) throw new AppError('SCHEDULE_NOT_FOUND', 'Plan tapılmadı', 404);
  if (body.title !== undefined) doc.title = clip(body.title, 40);
  if (body.pickup !== undefined) doc.pickup = toPoint(body.pickup);
  if (body.stops !== undefined) {
    if (!Array.isArray(body.stops) || !body.stops.length || body.stops.length > 4) throw new AppError('INVALID_POINTS', 'Təyinat seçin', 400);
    doc.stops = body.stops.map(toPoint);
  }
  if (body.vehicleType !== undefined) {
    const vt = pricing().normalizeVehicleType(body.vehicleType);
    if (!pricing().VEHICLE_TYPES.includes(vt)) throw new AppError('INVALID_VEHICLE_TYPE', 'Unknown vehicle type', 400);
    doc.vehicleType = vt;
  }
  const scheduleTouched = ['repeat', 'time', 'date', 'days'].some((k) => body[k] !== undefined);
  if (scheduleTouched) Object.assign(doc, parseSchedule(body, doc));
  const wantActive = body.active !== undefined ? !!body.active : doc.active;
  if (wantActive && (scheduleTouched || !doc.active || !doc.nextRunAt)) {
    if (wantActive && doc.active === false) {
      const activeCount = await ScheduledRide.countDocuments({ customerId: customer._id, active: true });
      if (activeCount >= MAX_ACTIVE) throw new AppError('SCHEDULE_LIMIT', `Ən çox ${MAX_ACTIVE} aktiv plan ola bilər`, 409);
    }
    doc.nextRunAt = assertRunnable(doc);
    doc.remindedFor = null;
  }
  doc.active = wantActive;
  if (!wantActive) doc.nextRunAt = null;
  await doc.save();
  return publicRide(doc);
}

async function remove({ customer }, id) {
  const r = await ScheduledRide.deleteOne({ _id: id, customerId: customer._id });
  if (!r.deletedCount) throw new AppError('SCHEDULE_NOT_FOUND', 'Plan tapılmadı', 404);
  return { removed: true };
}

/* ------------------------------------------------------------------ */
/* Bildiriş mətnləri                                                   */
/* ------------------------------------------------------------------ */

const TEXTS = {
  az: {
    reminder: ['Planlı sifariş', '{title}Sifarişiniz {time}-da avtomatik veriləcək'],
    ordered: ['Planlı sifariş verildi', '{title}Sizə sürücü axtarılır'],
    skipped: ['Planlı sifariş verilmədi', 'Aktiv sifarişiniz olduğu üçün {time} planı bu dəfə ötürüldü'],
    missed: ['Planlı sifariş vaxtında verilmədi', '{time} sifarişi verilə bilmədi. Lazımdırsa yenidən sifariş edin'],
    failed: ['Planlı sifariş verilmədi', '{time} sifarişi yaradıla bilmədi. Tətbiqi açıb yoxlayın'],
  },
  ru: {
    reminder: ['Запланированный заказ', '{title}Заказ будет оформлен автоматически в {time}'],
    ordered: ['Запланированный заказ оформлен', '{title}Ищем вам водителя'],
    skipped: ['Запланированный заказ не оформлен', 'У вас есть активный заказ, поэтому план на {time} пропущен'],
    missed: ['Запланированный заказ не оформлен вовремя', 'Заказ на {time} не удалось оформить. При необходимости закажите снова'],
    failed: ['Запланированный заказ не оформлен', 'Не удалось оформить заказ на {time}. Откройте приложение'],
  },
  en: {
    reminder: ['Scheduled ride', '{title}Your ride will be ordered automatically at {time}'],
    ordered: ['Scheduled ride ordered', '{title}We are finding you a driver'],
    skipped: ['Scheduled ride skipped', 'You already have an active ride, so the {time} plan was skipped'],
    missed: ['Scheduled ride missed', 'The {time} ride could not be ordered on time. Please order again if needed'],
    failed: ['Scheduled ride not ordered', 'The {time} ride could not be created. Please open the app'],
  },
  tr: {
    reminder: ['Planlı sipariş', '{title}Siparişiniz {time}\'da otomatik verilecek'],
    ordered: ['Planlı sipariş verildi', '{title}Size sürücü aranıyor'],
    skipped: ['Planlı sipariş verilmedi', 'Aktif siparişiniz olduğu için {time} planı bu sefer atlandı'],
    missed: ['Planlı sipariş zamanında verilemedi', '{time} siparişi verilemedi. Gerekirse yeniden sipariş verin'],
    failed: ['Planlı sipariş verilmedi', '{time} siparişi oluşturulamadı. Uygulamayı açıp kontrol edin'],
  },
};

const PUSH_TYPE = {
  reminder: 'scheduled_reminder',
  ordered: 'scheduled_order',
  skipped: 'scheduled_failed',
  missed: 'scheduled_failed',
  failed: 'scheduled_failed',
};

async function pushTo(ride, key, runAt, extra = {}) {
  try {
    const lang = await notify().languageOf(ride.customerId);
    const dict = TEXTS[lang] || TEXTS.az;
    const [title, body] = dict[key];
    const l = utcToLocal(runAt);
    const vars = { time: `${pad(l.hh)}:${pad(l.mm)}`, title: ride.title ? `${ride.title} · ` : '' };
    const fill = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : vars[k]));
    await push().sendToCustomer(ride.customerId, {
      title: fill(title),
      body: fill(body),
      type: PUSH_TYPE[key],
      tag: `sched_${ride._id}`,
      data: { scheduledRideId: String(ride._id), ...extra },
      ttlMs: key === 'reminder' ? REMIND_MS : 30 * 60 * 1000,
    });
  } catch (e) {
    console.error('[schedule] push göndərilmədi', e && e.message);
  }
}

function emitChanged(ride, payload = {}) {
  try {
    realtime().toCustomer(ride.customerId, 'scheduled_rides_changed', { scheduledRideId: String(ride._id), ...payload });
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* İcra                                                                */
/* ------------------------------------------------------------------ */

const ACTIVE_EXCLUDE = [
  OrderStatus.COMPLETED,
  OrderStatus.TRIP_COMPLETED,
  OrderStatus.RATING_PENDING,
  OrderStatus.CUSTOMER_CANCELLED,
  OrderStatus.DRIVER_CANCELLED,
  OrderStatus.ADMIN_CANCELLED,
  OrderStatus.EXPIRED,
];

async function sendReminders(now = new Date()) {
  const rows = await ScheduledRide.find({
    active: true,
    nextRunAt: { $gt: now, $lte: new Date(now.getTime() + REMIND_MS) },
    $expr: { $ne: ['$remindedFor', '$nextRunAt'] },
  })
    .limit(100)
    .lean();
  for (const r of rows) {
    const claimed = await ScheduledRide.updateOne(
      { _id: r._id, nextRunAt: r.nextRunAt, remindedFor: r.remindedFor },
      { $set: { remindedFor: r.nextRunAt } }
    );
    const modified = claimed.modifiedCount !== undefined ? claimed.modifiedCount : claimed.nModified;
    if (!modified) continue;
    // Plan elə indi yaradılıbsa xatırlatmanın mənası yoxdur
    if (r.createdAt && r.nextRunAt - new Date(r.createdAt) < REMIND_MS) continue;
    await pushTo(r, 'reminder', r.nextRunAt);
  }
  return rows.length;
}

/** Bir planın icrası (artıq atomik götürülüb). */
async function runOne(ride, runAt, now) {
  const set = (fields) => ScheduledRide.updateOne({ _id: ride._id }, { $set: fields });

  if (now - runAt > MISSED_MS) {
    await set({ lastStatus: 'MISSED', lastError: null });
    await pushTo(ride, 'missed', runAt);
    emitChanged(ride, { status: 'MISSED' });
    return 'MISSED';
  }

  const [customer, user] = await Promise.all([Customer.findById(ride.customerId), User.findById(ride.userId)]);
  if (!customer || !user || !user.isActive) {
    await ScheduledRide.updateOne({ _id: ride._id }, { $set: { active: false, nextRunAt: null, lastStatus: 'FAILED', lastError: 'ACCOUNT_UNAVAILABLE' } });
    return 'FAILED';
  }

  const busy = await Order.exists({ customerId: customer._id, status: { $nin: ACTIVE_EXCLUDE } });
  if (busy) {
    await set({ lastStatus: 'SKIPPED_ACTIVE', lastError: null });
    await pushTo(ride, 'skipped', runAt);
    emitChanged(ride, { status: 'SKIPPED_ACTIVE' });
    return 'SKIPPED_ACTIVE';
  }

  const stops = ride.stops.map((s) => ({ lat: s.lat, lng: s.lng, label: s.label, address: s.address }));
  try {
    const order = await orderService().createOrder({
      customer,
      user,
      pickup: { lat: ride.pickup.lat, lng: ride.pickup.lng, label: ride.pickup.label, address: ride.pickup.address },
      destination: stops[stops.length - 1],
      stops,
      vehicleType: ride.vehicleType,
      paymentMethod: 'CASH',
      // Eyni icra iki dəfə sifariş yaratmasın
      idempotencyKey: `sched:${ride._id}:${runAt.getTime()}`,
      scheduledRideId: ride._id,
    });
    await set({ lastStatus: 'CREATED', lastError: null, lastOrderId: order._id });
    realtime().toCustomer(ride.customerId, 'scheduled_ride_ordered', {
      scheduledRideId: String(ride._id),
      orderId: String(order._id),
    });
    await pushTo(ride, 'ordered', runAt, { orderId: String(order._id) });
    emitChanged(ride, { status: 'CREATED', orderId: String(order._id) });
    return 'CREATED';
  } catch (e) {
    const code = (e && e.code) || 'ORDER_FAILED';
    await set({ lastStatus: code === 'ACTIVE_ORDER_EXISTS' ? 'SKIPPED_ACTIVE' : 'FAILED', lastError: String(code).slice(0, 60) });
    await pushTo(ride, code === 'ACTIVE_ORDER_EXISTS' ? 'skipped' : 'failed', runAt);
    emitChanged(ride, { status: 'FAILED', error: code });
    console.error('[schedule] sifariş yaradılmadı', String(ride._id), code);
    return 'FAILED';
  }
}

async function processDue(now = new Date()) {
  const due = await ScheduledRide.find({ active: true, nextRunAt: { $ne: null, $lte: now } })
    .sort({ nextRunAt: 1 })
    .limit(50)
    .lean();
  const results = [];
  for (const r of due) {
    const runAt = new Date(r.nextRunAt);
    // Həftəlik: növbəti icra (server uzun müddət dayanıbsa keçmiş günlər üst-üstə yığılmasın - "indi"dən sonra)
    const next = r.repeat === 'weekly' ? computeNextRun(r, new Date(Math.max(now.getTime(), runAt.getTime()))) : null;
    const claimed = await ScheduledRide.findOneAndUpdate(
      { _id: r._id, active: true, nextRunAt: r.nextRunAt },
      { $set: { nextRunAt: next, active: !!next, lastRunAt: now, remindedFor: null } },
      { new: false }
    );
    if (!claimed) continue; // başqa instansiya götürdü
    try {
      results.push(await runOne(r, runAt, now));
    } catch (e) {
      console.error('[schedule] icra xətası', String(r._id), e && e.message);
    }
  }
  return results;
}

let timer = null;
let running = false;

function startScheduler(intervalMs = TICK_MS) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      await processDue(now);
      await sendReminders(now);
    } catch (e) {
      console.error('[schedule] planlaşdırıcı xətası', e && e.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  tick();
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  list,
  create,
  update,
  remove,
  processDue,
  sendReminders,
  computeNextRun,
  localToUtc,
  utcToLocal,
  parseSchedule,
  startScheduler,
  stopScheduler,
  publicRide,
  TEXTS,
};
