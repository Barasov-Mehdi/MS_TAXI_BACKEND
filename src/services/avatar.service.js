/**
 * Profil şəkli (avatar) — MongoDB GridFS-də (bucket: avatars). Heroku diski müvəqqəti olduğu üçün fayl sistemi istifadə olunmur.
 *
 *  Yükləmə:  POST   /customers/me/avatar  (multipart, sahə adı "file")  → { user }
 *  Silmə:    DELETE /customers/me/avatar                                 → { user }
 *  Göstərmə: GET    /app/avatars/:id  (giriş tələb etmir: tətbiqdəki <Image> və admin panel üçün)
 *
 * User.avatarUrl mütləq ünvandır. Yeni şəkil = yeni id (uzun keşləmə təhlükəsizdir), köhnə fayl silinir.
 * Tətbiq şəkli göndərməzdən əvvəl ≤ 640 px JPEG-ə kiçildir; server yenə də növü və ölçünü yoxlayır.
 */
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { AppError } = require('../utils/errors');
const { sniff } = require('./document.service');
const { baseUrl } = require('./newsImage.service');

const BUCKET = 'avatars';
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ID_RE = /\/app\/avatars\/([a-f0-9]{24})(?:[/?#]|$)/i;

let bucket = null;
function getBucket() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
  }
  return bucket;
}

const urlFor = (id, req) => `${baseUrl(req)}/app/avatars/${id}`;

/** avatarUrl-dan GridFS id-si (bizim ünvan deyilsə null). */
function idFromUrl(url) {
  const m = ID_RE.exec(String(url || ''));
  return m ? m[1] : null;
}

async function remove(id) {
  if (!id || !mongoose.isValidObjectId(String(id))) return;
  await getBucket().delete(new mongoose.Types.ObjectId(String(id))).catch(() => {});
}

/** Köhnə avatar faylını silir (xəta əsas əməliyyatı pozmur). */
async function removeByUrl(url) {
  const id = idFromUrl(url);
  if (id) await remove(id);
}

async function save(file, { userId } = {}) {
  if (!file || !file.buffer || !file.buffer.length) throw new AppError('VALIDATION_ERROR', 'Şəkil seçilməyib', 400);
  if (file.buffer.length > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'Şəkil ən çox 3 MB ola bilər', 413);
  const mime = sniff(file.buffer);
  if (!mime || !ALLOWED.has(mime)) throw new AppError('INVALID_FILE', 'Yalnız JPG, PNG və ya WEBP şəkil yükləmək olar', 400);
  const id = new mongoose.Types.ObjectId();
  await new Promise((resolve, reject) => {
    Readable.from(file.buffer)
      .pipe(getBucket().openUploadStreamWithId(id, `avatar_${id}`, { metadata: { mime, userId: userId ? String(userId) : null } }))
      .on('error', reject)
      .on('finish', resolve);
  });
  return String(id);
}

/** Şəkli yadda saxlayır, User.avatarUrl-ı yeniləyir, köhnə faylı silir. */
async function setForUser(user, file, req) {
  const id = await save(file, { userId: user._id });
  const old = user.avatarUrl;
  user.avatarUrl = urlFor(id, req);
  try {
    await user.save();
  } catch (e) {
    await remove(id);
    throw e;
  }
  if (old && old !== user.avatarUrl) await removeByUrl(old);
  return user.avatarUrl;
}

async function clearForUser(user) {
  const old = user.avatarUrl;
  if (!old) return;
  user.avatarUrl = null;
  await user.save();
  await removeByUrl(old);
}

async function stream(id, res) {
  if (!mongoose.isValidObjectId(String(id || ''))) throw new AppError('NOT_FOUND', 'Şəkil tapılmadı', 404);
  const _id = new mongoose.Types.ObjectId(String(id));
  const files = await getBucket().find({ _id }).limit(1).toArray();
  const f = files[0];
  if (!f) throw new AppError('NOT_FOUND', 'Şəkil tapılmadı', 404);
  res.setHeader('Content-Type', (f.metadata && f.metadata.mime) || 'image/jpeg');
  res.setHeader('Content-Length', String(f.length));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  await new Promise((resolve, reject) => {
    getBucket().openDownloadStream(_id).on('error', reject).on('end', resolve).pipe(res);
  });
}

module.exports = { setForUser, clearForUser, removeByUrl, idFromUrl, stream, urlFor, MAX_BYTES };
