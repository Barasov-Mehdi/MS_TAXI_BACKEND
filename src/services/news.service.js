/**
 * "Yeniliklər" — admin elanları sürücü tətbiqində ayrıca bölmədə.
 *
 * Fərq: "Ofislə əlaqə" şəxsi yazışmadır; Yeniliklər isə hamıya (və ya bir şəhərə) açıq, sabit lent kimi qalır.
 * Dərc olunanda:
 *   - socket: `news_published` (driver:<id> otaqlarına) → tətbiqdə banner + nişan
 *   - push:   `news` tipli bildiriş (tətbiq bağlı/arxa planda) → toxunanda Yeniliklər ekranı açılır
 */
const mongoose = require('mongoose');
const { News, Driver } = require('../models');
const { AppError } = require('../utils/errors');

const PAGE = 30;

function publicNews(n) {
  return {
    id: String(n._id),
    title: n.title,
    body: n.body,
    kind: n.kind || 'info',
    cityId: n.cityId ? String(n.cityId) : null,
    pinned: !!n.pinned,
    linkUrl: n.linkUrl || null,
    linkLabel: n.linkLabel || null,
    publishedAt: n.publishedAt,
  };
}

/** Sürücünün görə biləcəyi xəbərlər: ümumi + öz şəhəri, vaxtı çatmış, bitməmiş, silinməmiş. */
function visibleQuery(driver, now = new Date()) {
  const cities = [null];
  if (driver && driver.cityId) cities.push(new mongoose.Types.ObjectId(String(driver.cityId)));
  return {
    deletedAt: null,
    cityId: { $in: cities },
    publishedAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
}

async function listForDriver(driver, { before, limit = PAGE } = {}) {
  const q = visibleQuery(driver);
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
  const seenAt = driver.newsSeenAt ? new Date(driver.newsSeenAt).getTime() : 0;
  return {
    news: rows.slice(0, lim).map((n) => ({ ...publicNews(n), unread: new Date(n.publishedAt).getTime() > seenAt })),
    hasMore,
  };
}

async function unreadForDriver(driver) {
  if (!driver) return 0;
  const q = visibleQuery(driver);
  if (driver.newsSeenAt) q.publishedAt = { $gt: new Date(driver.newsSeenAt), $lte: new Date() };
  return News.countDocuments(q);
}

async function markReadByDriver(driverId) {
  await Driver.updateOne({ _id: driverId }, { $set: { newsSeenAt: new Date() } });
}

// ------------------------------------------------------------------ Admin

const clean = (v, max) => String(v || '').replace(/\r\n/g, '\n').trim().slice(0, max);

/**
 * Admin üçün siyahı. scope: { isSuper, cityId } (middleware/adminScope.scopeOf).
 * Regional admin öz şəhərinin və ümumi xəbərləri görür (ümumi olanları dəyişə bilməz).
 */
async function listForAdmin(scope, { cityId, limit = 100 } = {}) {
  const q = { deletedAt: null };
  if (!scope.isSuper) q.cityId = { $in: [null, new mongoose.Types.ObjectId(scope.cityId)] };
  else if (cityId === 'none') q.cityId = null;
  else if (cityId && mongoose.isValidObjectId(cityId)) q.cityId = new mongoose.Types.ObjectId(cityId);
  const rows = await News.find(q).sort({ publishedAt: -1 }).limit(Math.min(Number(limit) || 100, 300)).lean();
  return rows.map((n) => ({ ...publicNews(n), expiresAt: n.expiresAt, createdBy: n.createdBy, createdAt: n.createdAt }));
}

/** Regional admin yalnız öz şəhərinə yazır; baş admin cityId=null (hamı) və ya istənilən şəhər. */
function resolveCity(scope, cityId) {
  if (!scope.isSuper) return new mongoose.Types.ObjectId(scope.cityId);
  if (!cityId) return null;
  if (!mongoose.isValidObjectId(String(cityId))) throw new AppError('VALIDATION_ERROR', 'cityId yanlışdır', 400);
  return new mongoose.Types.ObjectId(String(cityId));
}

async function loadInScope(scope, id) {
  if (!mongoose.isValidObjectId(String(id || ''))) throw new AppError('NOT_FOUND', 'Xəbər tapılmadı', 404);
  const n = await News.findOne({ _id: id, deletedAt: null });
  if (!n) throw new AppError('NOT_FOUND', 'Xəbər tapılmadı', 404);
  if (!scope.isSuper && String(n.cityId || '') !== String(scope.cityId)) {
    throw new AppError('FORBIDDEN', 'Bu xəbəri yalnız baş admin dəyişə bilər', 403);
  }
  return n;
}

/** Dərc olunan xəbəri sürücülərə çatdırır (socket + push). Xəta əsas əməliyyatı pozmur. */
async function announce(news, { push = true } = {}) {
  // eslint-disable-next-line global-require
  const realtime = require('../websocket/emitter');
  // eslint-disable-next-line global-require
  const pushService = require('./push.service');
  const q = { deletedAt: null, isActive: true };
  if (news.cityId) q.cityId = news.cityId;
  const drivers = await Driver.find(q).select('_id').lean();
  const pub = publicNews(news);
  let pushed = 0;
  for (const d of drivers) {
    realtime.toDriver(d._id, 'news_published', pub);
    if (push) {
      // eslint-disable-next-line no-await-in-loop
      const okSent = await pushService.notifyNews(d._id, pub).catch(() => false);
      if (okSent) pushed += 1;
    }
  }
  return { drivers: drivers.length, pushed };
}

async function create(admin, scope, body) {
  const doc = await News.create({
    title: clean(body.title, 120),
    body: clean(body.body, 4000),
    kind: body.kind || 'info',
    cityId: resolveCity(scope, body.cityId),
    pinned: !!body.pinned,
    linkUrl: body.linkUrl ? clean(body.linkUrl, 500) : null,
    linkLabel: body.linkLabel ? clean(body.linkLabel, 40) : null,
    publishedAt: body.publishedAt ? new Date(body.publishedAt) : new Date(),
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    createdBy: admin && admin._id,
  });
  // Gələcək tarixə planlaşdırılıbsa indi elan olunmur (tətbiq vaxtı çatanda siyahıda görəcək)
  let delivery = { drivers: 0, pushed: 0, scheduled: doc.publishedAt > new Date() };
  if (!delivery.scheduled) {
    delivery = { ...(await announce(doc, { push: body.notify !== false }).catch((e) => {
      console.error('[news] elan göndərilmədi', e && e.message);
      return { drivers: 0, pushed: 0 };
    })), scheduled: false };
  }
  return { news: publicNews(doc), delivery };
}

async function update(scope, id, body) {
  const n = await loadInScope(scope, id);
  if (body.title !== undefined) n.title = clean(body.title, 120);
  if (body.body !== undefined) n.body = clean(body.body, 4000);
  if (body.kind !== undefined) n.kind = body.kind;
  if (body.pinned !== undefined) n.pinned = !!body.pinned;
  if (body.linkUrl !== undefined) n.linkUrl = body.linkUrl ? clean(body.linkUrl, 500) : null;
  if (body.linkLabel !== undefined) n.linkLabel = body.linkLabel ? clean(body.linkLabel, 40) : null;
  if (body.expiresAt !== undefined) n.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (body.cityId !== undefined && scope.isSuper) n.cityId = resolveCity(scope, body.cityId);
  await n.save();
  return publicNews(n);
}

async function remove(scope, id) {
  const n = await loadInScope(scope, id);
  n.deletedAt = new Date();
  await n.save();
  return { deleted: true };
}

module.exports = {
  publicNews,
  listForDriver,
  unreadForDriver,
  markReadByDriver,
  listForAdmin,
  create,
  update,
  remove,
  announce,
  visibleQuery,
};
