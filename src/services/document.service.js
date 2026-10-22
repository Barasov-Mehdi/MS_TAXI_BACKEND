const mongoose = require('mongoose');
const { Readable } = require('stream');
const { DriverDocument } = require('../models');
const { AppError } = require('../utils/errors');

const BUCKET = 'driverDocs';
const MAX_BYTES = 8 * 1024 * 1024;
const { DOC_TYPES: TYPES, DOC_LABELS } = require('../utils/documentTypes');

const LABELS = DOC_LABELS;

let bucket = null;
function getBucket() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
  }
  return bucket;
}

/** Faylın əsl növünü ilk baytlardan yoxlayır (uzantıya/mime-a etibar edilmir). */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(4, 12).toString().includes('ftyphei') || buf.slice(4, 12).toString().includes('ftypmif')) return 'image/heic';
  return null;
}

function assertType(type) {
  if (!TYPES.includes(type)) throw new AppError('VALIDATION_ERROR', 'Sənəd növü düzgün deyil', 400);
}

function publicDoc(d) {
  if (!d) return null;
  return {
    _id: d._id,
    type: d.type,
    label: LABELS[d.type] || d.type,
    status: d.status,
    rejectReason: d.rejectReason || '',
    size: d.size,
    mime: d.mime,
    uploadedAt: d.updatedAt || d.createdAt,
    reviewedAt: d.reviewedAt,
  };
}

/** Bütün növlər (yüklənməyənlər də) + xülasə. */
async function listForDriver(driverId) {
  const docs = await DriverDocument.find({ driverId }).lean();
  const byType = new Map(docs.map((d) => [d.type, d]));
  const items = TYPES.map((type) => {
    const d = byType.get(type);
    return d ? publicDoc(d) : { type, label: LABELS[type], status: 'MISSING' };
  });
  return { documents: items, summary: summarize(items) };
}

function summarize(items) {
  const count = (s) => items.filter((i) => i.status === s).length;
  const approved = count('APPROVED');
  return {
    required: TYPES.length,
    uploaded: items.length - count('MISSING'),
    approved,
    pending: count('PENDING'),
    rejected: count('REJECTED'),
    missing: count('MISSING'),
    complete: approved === TYPES.length,
  };
}

/** Yükləmə: köhnə fayl (varsa) əvəz olunur, status yenidən PENDING. */
async function upload(driverId, type, file) {
  assertType(type);
  if (!file || !file.buffer || !file.buffer.length) throw new AppError('VALIDATION_ERROR', 'Şəkil seçilməyib', 400);
  if (file.buffer.length > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'Şəkil ən çox 8 MB ola bilər', 413);
  const mime = sniff(file.buffer);
  if (!mime) throw new AppError('INVALID_FILE', 'Yalnız şəkil (JPG, PNG, WEBP) yükləmək olar', 400);

  const fileId = await new Promise((resolve, reject) => {
    const up = getBucket().openUploadStream(`${driverId}-${type}`, {
      contentType: mime,
      metadata: { driverId: String(driverId), type },
    });
    Readable.from(file.buffer).pipe(up).on('error', reject).on('finish', () => resolve(up.id));
  });

  const old = await DriverDocument.findOne({ driverId, type });
  let doc;
  if (old) {
    const oldFile = old.fileId;
    old.set({ fileId, mime, size: file.buffer.length, status: 'PENDING', rejectReason: '', reviewedBy: null, reviewedAt: null });
    doc = await old.save();
    getBucket().delete(oldFile).catch(() => {});
  } else {
    doc = await DriverDocument.create({ driverId, type, fileId, mime, size: file.buffer.length });
  }
  return publicDoc(doc);
}

/** Faylı cavaba yazır (şəkil). */
async function streamFile(doc, res) {
  res.setHeader('Content-Type', doc.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await new Promise((resolve, reject) => {
    getBucket()
      .openDownloadStream(doc.fileId)
      .on('error', reject)
      .on('end', resolve)
      .pipe(res);
  });
}

async function review(docId, admin, { approve, reason }) {
  const doc = await DriverDocument.findById(docId);
  if (!doc) throw new AppError('NOT_FOUND', 'Sənəd tapılmadı', 404);
  doc.status = approve ? 'APPROVED' : 'REJECTED';
  doc.rejectReason = approve ? '' : String(reason || '').slice(0, 300);
  doc.reviewedBy = admin._id;
  doc.reviewedAt = new Date();
  await doc.save();
  return doc;
}

module.exports = { TYPES, LABELS, MAX_BYTES, listForDriver, upload, streamFile, review, publicDoc, summarize, sniff };
