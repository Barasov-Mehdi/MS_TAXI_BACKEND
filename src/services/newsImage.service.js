/**
 * "Yeniliklər" şəkilləri — MongoDB GridFS-də (bucket: newsImages). Heroku diski müvəqqəti olduğu üçün fayl sistemi istifadə olunmur.
 *
 *  Yükləmə:  POST /admin/news/image  (multipart, sahə adı "file")  → { imageId, imageUrl }
 *  Göstərmə: GET  /app/news-images/:id  (giriş tələb etmir: tətbiqdəki <Image>, admin panel və push şəkli üçün)
 *
 * imageUrl mütləq ünvandır (push bildirişində şəkil göstərmək üçün lazımdır).
 * Ünvan PUBLIC_API_URL (Heroku Config Var) varsa ondan, yoxdursa yükləmə sorğusunun host-undan qurulur.
 */
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { AppError } = require('../utils/errors');
const { sniff } = require('./document.service');

const BUCKET = 'newsImages';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

let bucket = null;
function getBucket() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
  }
  return bucket;
}

/** Mütləq baza ünvanı: PUBLIC_API_URL → sorğunun özü (Heroku-da trust proxy=1 olduğu üçün https düzgün gəlir). */
function baseUrl(req) {
  const env = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  if (!req) return '';
  return `${req.protocol}://${req.get('host')}`;
}

const urlFor = (id, req) => `${baseUrl(req)}/app/news-images/${id}`;

async function upload(file, { uploadedBy } = {}) {
  if (!file || !file.buffer || !file.buffer.length) throw new AppError('VALIDATION_ERROR', 'Şəkil seçilməyib', 400);
  if (file.buffer.length > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'Şəkil ən çox 5 MB ola bilər', 413);
  const mime = sniff(file.buffer);
  if (!mime || !ALLOWED.has(mime)) throw new AppError('INVALID_FILE', 'Yalnız JPG, PNG və ya WEBP şəkil yükləmək olar', 400);
  const id = new mongoose.Types.ObjectId();
  await new Promise((resolve, reject) => {
    Readable.from(file.buffer)
      .pipe(getBucket().openUploadStreamWithId(id, `news_${id}`, { metadata: { mime, uploadedBy: uploadedBy || null } }))
      .on('error', reject)
      .on('finish', resolve);
  });
  return { imageId: String(id), mime, size: file.buffer.length };
}

async function stream(id, res) {
  if (!mongoose.isValidObjectId(String(id || ''))) throw new AppError('NOT_FOUND', 'Şəkil tapılmadı', 404);
  const _id = new mongoose.Types.ObjectId(String(id));
  const files = await getBucket().find({ _id }).limit(1).toArray();
  const f = files[0];
  if (!f) throw new AppError('NOT_FOUND', 'Şəkil tapılmadı', 404);
  res.setHeader('Content-Type', (f.metadata && f.metadata.mime) || 'image/jpeg');
  res.setHeader('Content-Length', String(f.length));
  // Şəkil dəyişmir (yeni şəkil = yeni id): uzun keşləmə
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // helmet defolt "same-origin" qoyur: admin panel (başqa domen) <img> ilə göstərə bilsin
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  await new Promise((resolve, reject) => {
    getBucket().openDownloadStream(_id).on('error', reject).on('end', resolve).pipe(res);
  });
}

/** Köhnə şəkli silir (xəbərin şəkli dəyişəndə). Xəta əsas əməliyyatı pozmur. */
async function remove(id) {
  if (!id || !mongoose.isValidObjectId(String(id))) return;
  await getBucket().delete(new mongoose.Types.ObjectId(String(id))).catch(() => {});
}

module.exports = { upload, stream, remove, urlFor, baseUrl, MAX_BYTES };
