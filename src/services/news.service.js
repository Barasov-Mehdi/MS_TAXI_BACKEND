/**
 * "Yeniliklər" — admin elanları sürücü və/və ya müştəri tətbiqində ayrıca bölmədə.
 *
 * Auditoriya (News.audience):
 *   drivers   → yalnız sürücülər (şəhərə görə də məhdudlaşdırıla bilər)
 *   customers → yalnız müştərilər (həmişə ümumi, cityId = null)
 *   all       → hər iki tətbiq (cityId = null)
 *
 * Fərq: "Ofislə əlaqə" şəxsi yazışmadır; Yeniliklər isə hamıya (və ya bir şəhərə) açıq, sabit lent kimi qalır.
 * Dərc olunanda:
 *   - socket: `news_published` (sürücü: driver:<id> otaqları, müştəri: `customers` otağı) → tətbiqdə banner + nişan
 *   - push:   `news` tipli bildiriş (tətbiq bağlı/arxa planda) → toxunanda Yeniliklər ekranı açılır
 */
const mongoose = require('mongoose');
const { News, Driver, Customer } = require('../models');
const { AppError } = require('../utils/errors');
const imageService = require('./newsImage.service');

const PAGE = 30;
const AUDIENCES = ['drivers', 'customers', 'all'];

/** Köhnə qeydlərdə audience yoxdur → sürücü elanı sayılır. */
const audienceOf = (n) => (n && AUDIENCES.includes(n.audience) ? n.audience : 'drivers');
const forDrivers = (n) => audienceOf(n) !== 'customers';
const forCustomers = (n) => audienceOf(n) !== 'drivers';

function publicNews(n) {
  return {
    id: String(n._id),
    title: n.title,
    body: n.body,
    kind: n.kind || 'info',
    audience: audienceOf(n),
    cityId: n.cityId ? String(n.cityId) : null,
    pinned: !!n.pinned,
    linkUrl: n.linkUrl || null,
    linkLabel: n.linkLabel || null,
    // PUBLIC_API_URL varsa ondan, yoxdursa yükləmə zamanı yadda saxlanmış mütləq ünvan
    imageUrl: n.imageId ? (process.env.PUBLIC_API_URL ? imageService.urlFor(n.imageId, null) : n.imageUrl || null) : null,
    publishedAt: n.publishedAt,
  };
}

const liveWindow = (now) => ({
  deletedAt: null,
  publishedAt: { $lte: now },
  $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
});

/** Sürücünün görə biləcəyi xəbərlər: sürücü/hamı elanları, ümumi + öz şəhəri, vaxtı çatmış, bitməmiş, silinməmiş. */
function visibleQuery(driver, now = new Date()) {
  const cities = [null];
  if (driver && driver.cityId) cities.push(new mongoose.Types.ObjectId(String(driver.cityId)));
  return {
    ...liveWindow(now),
    cityId: { $in: cities },
    // null → köhnə qeydlər (audience sahəsi yoxdur)
    audience: { $in: ['drivers', 'all', null] },
  };
}

/** Müştərinin görə biləcəyi xəbərlər: müştəri/hamı elanları (həmişə ümumi). */
function customerVisibleQuery(now = new Date()) {
  return { ...liveWindow(now), audience: { $in: ['customers', 'all'] } };
}

async function listPage(baseQuery, seenAtRaw, { before, limit = PAGE } = {}) {
  const q = { ...baseQuery };
  const lim = Math.min(Math.max(Number(limit) || PAGE, 1), 100);
  if (before) {
    const b = new Date(before);
    if (!Number.isNaN(b.getTime())) q.publishedAt = { $lt: b, $lte: new Date() };
  }
  // Bərkidilmişlər yalnız birinci səhifədə yuxarıda
  const rows = await News.find(q)
    .sort(before ? { publishedAt: -1 } : { pinned: -1, publishedAt: -1 })
    .limit(lim + 1)
    .lean();
  const hasMore = rows.length > lim;
  const seenAt = seenAtRaw ? new Date(seenAtRaw).getTime() : 0;
  return {
    news: rows.slice(0, lim).map((n) => ({ ...publicNews(n), unread: new Date(n.publishedAt).getTime() > seenAt })),
    hasMore,
  };
}

async function countUnread(baseQuery, seenAtRaw) {
  const q = { ...baseQuery };
  if (seenAtRaw) q.publishedAt = { $gt: new Date(seenAtRaw), $lte: new Date() };
  return News.countDocuments(q);
}

// ------------------------------------------------------------------ Sürücü

async function listForDriver(driver, opts = {}) {
  return listPage(visibleQuery(driver), driver.newsSeenAt, opts);
}

async function unreadForDriver(driver) {
  if (!driver) return 0;
  return countUnread(visibleQuery(driver), driver.newsSeenAt);
}

async function markReadByDriver(driverId) {
  await Driver.updateOne({ _id: driverId }, { $set: { newsSeenAt: new Date() } });
}

// ------------------------------------------------------------------ Müştəri

async function listForCustomer(customer, opts = {}) {
  return listPage(customerVisibleQuery(), customer && customer.newsSeenAt, opts);
}

async function unreadForCustomer(customer) {
  if (!customer) return 0;
  return countUnread(customerVisibleQuery(), customer.newsSeenAt);
}

async function markReadByCustomer(customerId) {
  await Customer.updateOne({ _id: customerId }, { $set: { newsSeenAt: new Date() } });
}

// ------------------------------------------------------------------ Admin

const clean = (v, max) => String(v || '').replace(/\r\n/g, '\n').trim().slice(0, max);

/**
 * Admin üçün siyahı. scope: { isSuper, cityId } (middleware/adminScope.scopeOf).
 * Regional admin öz şəhərinin və ümumi xəbərləri görür (ümumi olanları dəyişə bilməz).
 * audience filtri: drivers | customers | all (yalnız "hamısı" elanları) — boş → hamısı.
 */
async function listForAdmin(scope, { cityId, audience, limit = 100 } = {}) {
  const q = { deletedAt: null };
  if (!scope.isSuper) q.cityId = { $in: [null, new mongoose.Types.ObjectId(scope.cityId)] };
  else if (cityId === 'none') q.cityId = null;
  else if (cityId && mongoose.isValidObjectId(cityId)) q.cityId = new mongoose.Types.ObjectId(cityId);
  if (audience === 'drivers') q.audience = { $in: ['drivers', null] };
  else if (audience === 'customers' || audience === 'all') q.audience = audience;
  const rows = await News.find(q).sort({ publishedAt: -1 }).limit(Math.min(Number(limit) || 100, 300)).lean();
  return rows.map((n) => ({
    ...publicNews(n),
    expiresAt: n.expiresAt,
    announcedAt: n.announcedAt,
    scheduled: !n.announcedAt && new Date(n.publishedAt) > new Date(),
    silent: !!n.silent,
    createdBy: n.createdBy,
    createdAt: n.createdAt,
  }));
}

/** Regional admin yalnız öz şəhərinə yazır; baş admin cityId=null (hamı) və ya istənilən şəhər. */
function resolveCity(scope, cityId) {
  if (!scope.isSuper) return new mongoose.Types.ObjectId(scope.cityId);
  if (!cityId) return null;
  if (!mongoose.isValidObjectId(String(cityId))) throw new AppError('VALIDATION_ERROR', 'cityId yanlışdır', 400);
  return new mongoose.Types.ObjectId(String(cityId));
}

/**
 * Auditoriya qaydaları:
 *  - regional admin yalnız sürücülərə (öz şəhərinə) yaza bilər;
 *  - müştərilərə gedən elan şəhərə bağlana bilməz (müştərilərin şəhəri yoxdur).
 */
function resolveAudience(scope, audience, cityId) {
  const a = audience === undefined || audience === null || audience === '' ? 'drivers' : String(audience);
  if (!AUDIENCES.includes(a)) throw new AppError('VALIDATION_ERROR', 'audience: drivers, customers və ya all', 400);
  if (a !== 'drivers' && !scope.isSuper) {
    throw new AppError('FORBIDDEN', 'Müştərilərə elanı yalnız baş admin göndərə bilər', 403);
  }
  if (a !== 'drivers' && cityId) {
    throw new AppError('VALIDATION_ERROR', 'Müştərilərə gedən elan şəhərə bağlana bilməz (şəhər: "Bütün şəhərlər" seçin)', 400);
  }
  return a;
}

async function loadInScope(scope, id) {
  if (!mongoose.isValidObjectId(String(id || ''))) throw new AppError('NOT_FOUND', 'Xəbər tapılmadı', 404);
  const n = await News.findOne({ _id: id, deletedAt: null });
  if (!n) throw new AppError('NOT_FOUND', 'Xəbər tapılmadı', 404);
  if (!scope.isSuper && (String(n.cityId || '') !== String(scope.cityId) || !forDrivers(n) || audienceOf(n) !== 'drivers')) {
    throw new AppError('FORBIDDEN', 'Bu xəbəri yalnız baş admin dəyişə bilər', 403);
  }
  return n;
}

/** Müştərilərə push: çox ola bilər, eyni anda `concurrency` qədər göndərilir. */
async function pushCustomers(pub, { concurrency = 10 } = {}) {
  // eslint-disable-next-line global-require
  const pushService = require('./push.service');
  const targets = await Customer.find({ fcmToken: { $ne: null } }).select('_id').lean();
  let pushed = 0;
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const c = targets[i++];
      // eslint-disable-next-line no-await-in-loop
      const okSent = await pushService
        .sendToCustomer(c._id, {
          title: String(pub.title || 'Yenilik').slice(0, 80),
          body: pub.body,
          type: 'news',
          channel: 'news',
          tag: 'news',
          data: { newsId: pub.id },
          ttlMs: 24 * 60 * 60 * 1000,
          imageUrl: pub.imageUrl || undefined,
        })
        .catch(() => false);
      if (okSent) pushed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return { targets: targets.length, pushed };
}

/**
 * Dərc olunan xəbəri auditoriyasına çatdırır (socket + push). Xəta əsas əməliyyatı pozmur.
 * Müştəri push-ları arxa planda gedir (çox ola bilər): cavabda yalnız hədəf sayı qaytarılır,
 * waitCustomers=true olanda (planlaşdırıcı, testlər) göndərilmə gözlənilir.
 */
async function announce(news, { push = true, waitCustomers = false } = {}) {
  // eslint-disable-next-line global-require
  const realtime = require('../websocket/emitter');
  // eslint-disable-next-line global-require
  const pushService = require('./push.service');
  const pub = publicNews(news);
  const result = { drivers: 0, pushed: 0, customers: 0, customerPushed: null };

  if (forDrivers(news)) {
    const q = { deletedAt: null, isActive: true };
    if (news.cityId) q.cityId = news.cityId;
    const drivers = await Driver.find(q).select('_id').lean();
    result.drivers = drivers.length;
    for (const d of drivers) {
      realtime.toDriver(d._id, 'news_published', pub);
      if (push) {
        // eslint-disable-next-line no-await-in-loop
        const okSent = await pushService.notifyNews(d._id, pub).catch(() => false);
        if (okSent) result.pushed += 1;
      }
    }
  }

  if (forCustomers(news)) {
    try {
      if (realtime.toCustomers) realtime.toCustomers('news_published', pub);
    } catch (_) { /* səssiz */ }
    if (push) {
      const job = pushCustomers(pub);
      if (waitCustomers) {
        const r = await job.catch(() => ({ targets: 0, pushed: 0 }));
        result.customers = r.targets;
        result.customerPushed = r.pushed;
      } else {
        result.customers = await Customer.countDocuments({ fcmToken: { $ne: null } }).catch(() => 0);
        job
          .then((r) => console.log(`[news] müştərilərə push: ${r.pushed}/${r.targets}`))
          .catch((e) => console.error('[news] müştəri push alınmadı', e && e.message));
      }
    }
  }
  return result;
}

/** Admin panelinin açıq səhifələri üçün (Yeniliklər siyahısı canlı yenilənsin). */
function toAdmins(news, action) {
  try {
    // eslint-disable-next-line global-require
    require('../websocket/emitter').toAdminsFor(news.cityId || null, 'admin_news', { action, news: publicNews(news) });
  } catch (_) { /* səssiz */ }
}

/** Açıq tətbiqlərə dəyişiklik/silinmə (bildiriş yox, yalnız siyahı yenilənir) — auditoriyasına görə. */
function toApps(news, event, payload) {
  try {
    // eslint-disable-next-line global-require
    const rt = require('../websocket/emitter');
    if (forDrivers(news)) rt.toDrivers(news.cityId || null, event, payload);
    if (forCustomers(news) && rt.toCustomers) rt.toCustomers(event, payload);
  } catch (_) { /* səssiz */ }
}

async function create(admin, scope, body) {
  const now = new Date();
  const publishedAt = body.publishedAt ? new Date(body.publishedAt) : now;
  const scheduled = publishedAt > now;
  const cityId = resolveCity(scope, body.cityId);
  const audience = resolveAudience(scope, body.audience, cityId);
  const doc = await News.create({
    title: clean(body.title, 120),
    body: clean(body.body, 4000),
    kind: body.kind || 'info',
    audience,
    cityId,
    pinned: !!body.pinned,
    linkUrl: body.linkUrl ? clean(body.linkUrl, 500) : null,
    linkLabel: body.linkLabel ? clean(body.linkLabel, 40) : null,
    imageId: body.imageId || null,
    imageUrl: body.imageId ? body.imageUrl || null : null,
    publishedAt,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    createdBy: admin && admin._id,
    // Planlaşdırılıbsa planlaşdırıcı (startScheduler) vaxtı çatanda göndərəcək; push istənməyibsə də qeyd olunur
    announcedAt: scheduled ? null : now,
    silent: body.notify === false,
  });
  let delivery = { drivers: 0, pushed: 0, customers: 0, customerPushed: null, scheduled };
  if (!scheduled) {
    delivery = {
      ...(await announce(doc, { push: body.notify !== false }).catch((e) => {
        console.error('[news] elan göndərilmədi', e && e.message);
        return { drivers: 0, pushed: 0, customers: 0, customerPushed: null };
      })),
      scheduled: false,
    };
  }
  toAdmins(doc, 'created');
  return { news: publicNews(doc), delivery };
}

async function update(scope, id, body) {
  const n = await loadInScope(scope, id);
  const before = { cityId: n.cityId, audience: audienceOf(n) };
  if (body.title !== undefined) n.title = clean(body.title, 120);
  if (body.body !== undefined) n.body = clean(body.body, 4000);
  if (body.kind !== undefined) n.kind = body.kind;
  if (body.pinned !== undefined) n.pinned = !!body.pinned;
  if (body.linkUrl !== undefined) n.linkUrl = body.linkUrl ? clean(body.linkUrl, 500) : null;
  if (body.linkLabel !== undefined) n.linkLabel = body.linkLabel ? clean(body.linkLabel, 40) : null;
  if (body.expiresAt !== undefined) n.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (body.imageId !== undefined && String(body.imageId || '') !== String(n.imageId || '')) {
    const old = n.imageId;
    n.imageId = body.imageId || null;
    n.imageUrl = body.imageId ? body.imageUrl || null : null;
    if (old) imageService.remove(old); // köhnə şəkil GridFS-dən silinir
  }
  if (body.cityId !== undefined && scope.isSuper) n.cityId = resolveCity(scope, body.cityId);
  if (body.audience !== undefined || body.cityId !== undefined) {
    n.audience = resolveAudience(scope, body.audience !== undefined ? body.audience : audienceOf(n), n.cityId);
  }
  // Hələ elan olunmamış (planlaşdırılmış) xəbərin vaxtı dəyişdirilə bilər
  if (body.publishedAt !== undefined && !n.announcedAt && body.publishedAt) n.publishedAt = new Date(body.publishedAt);
  await n.save();
  const pub = publicNews(n);
  if (n.announcedAt) {
    // Şəhər və ya auditoriya dəyişibsə: artıq görməməli olan tətbiqlərdən silinsin
    const old = { cityId: before.cityId, audience: before.audience };
    const cityChanged = String(before.cityId || '') !== String(n.cityId || '');
    if (cityChanged && forDrivers(old)) toApps({ cityId: old.cityId, audience: 'drivers' }, 'news_deleted', { id: pub.id });
    if (forDrivers(old) && !forDrivers(n)) toApps({ cityId: old.cityId, audience: 'drivers' }, 'news_deleted', { id: pub.id });
    if (forCustomers(old) && !forCustomers(n)) toApps({ audience: 'customers' }, 'news_deleted', { id: pub.id });
    toApps(n, 'news_updated', pub);
  }
  toAdmins(n, 'updated');
  return pub;
}

async function remove(scope, id) {
  const n = await loadInScope(scope, id);
  n.deletedAt = new Date();
  await n.save();
  toApps(n, 'news_deleted', { id: String(n._id) });
  toAdmins(n, 'deleted');
  return { deleted: true };
}

/**
 * Vaxtı çatmış, hələ elan olunmamış xəbərləri göndərir.
 * Atomik "götürmə" (findOneAndUpdate) — bir neçə dyno işləsə də hər xəbər bir dəfə göndərilir.
 */
async function announceDue(now = new Date()) {
  let count = 0;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const n = await News.findOneAndUpdate(
      { deletedAt: null, announcedAt: null, publishedAt: { $lte: now }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { $set: { announcedAt: now } },
      { new: true, sort: { publishedAt: 1 } }
    ).lean();
    if (!n) break;
    // eslint-disable-next-line no-await-in-loop
    await announce(n, { push: !n.silent }).catch((e) => console.error('[news] planlı elan alınmadı', e && e.message));
    toAdmins(n, 'announced');
    count += 1;
  }
  return count;
}

let timer = null;
function startScheduler(intervalMs = 30000) {
  if (timer) return;
  const tick = () => announceDue().catch((e) => console.error('[news] planlaşdırıcı', e && e.message));
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  tick();
}
function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  AUDIENCES,
  publicNews,
  listForDriver,
  unreadForDriver,
  markReadByDriver,
  listForCustomer,
  unreadForCustomer,
  markReadByCustomer,
  listForAdmin,
  create,
  update,
  remove,
  announce,
  announceDue,
  startScheduler,
  stopScheduler,
  visibleQuery,
  customerVisibleQuery,
};
