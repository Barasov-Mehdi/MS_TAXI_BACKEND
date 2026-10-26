/**
 * Müştərinin ünvanları (Ev, İş, digər adlı ünvanlar).
 * Ev və İş hər müştəri üçün birdir: yenisi yazılanda köhnəsi əvəz olunur.
 */
const { SavedPlace } = require('../models');
const { AppError } = require('../utils/errors');

const MAX_PLACES = 20;
const KINDS = ['home', 'work', 'other'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function publicPlace(p) {
  return {
    id: String(p._id),
    kind: p.kind,
    name: p.name || '',
    label: p.label || '',
    address: p.address || '',
    lat: p.lat,
    lng: p.lng,
    useCount: p.useCount || 0,
    updatedAt: p.updatedAt,
  };
}

function parse(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.kind !== undefined) {
    const kind = KINDS.includes(body.kind) ? body.kind : 'other';
    out.kind = kind;
  }
  if (!partial || body.name !== undefined) out.name = clip(body.name, 40);
  if (!partial || body.label !== undefined) out.label = clip(body.label, 200);
  if (!partial || body.address !== undefined) out.address = clip(body.address, 300);
  if (!partial || body.lat !== undefined || body.lng !== undefined) {
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new AppError('INVALID_LOCATION', 'Ünvanın koordinatı düzgün deyil', 400);
    }
    out.lat = lat;
    out.lng = lng;
  }
  if (out.kind === 'other' && out.name !== undefined && !out.name && !out.label) {
    throw new AppError('PLACE_NAME_REQUIRED', 'Ünvana ad verin', 400);
  }
  return out;
}

async function list(customerId) {
  const rows = await SavedPlace.find({ customerId }).sort({ kind: 1, useCount: -1, updatedAt: -1 }).lean();
  // Sıra: Ev, İş, sonra digərləri (çox istifadə olunan yuxarıda)
  const rank = { home: 0, work: 1, other: 2 };
  rows.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.useCount || 0) - (a.useCount || 0));
  return rows.map(publicPlace);
}

async function create(customerId, body) {
  const data = parse(body);
  if (data.kind === 'home' || data.kind === 'work') {
    const doc = await SavedPlace.findOneAndUpdate(
      { customerId, kind: data.kind },
      { $set: { ...data, customerId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return publicPlace(doc);
  }
  const count = await SavedPlace.countDocuments({ customerId });
  if (count >= MAX_PLACES) throw new AppError('PLACES_LIMIT', `Ən çox ${MAX_PLACES} ünvan saxlamaq olar`, 409);
  const doc = await SavedPlace.create({ ...data, customerId });
  return publicPlace(doc);
}

async function update(customerId, id, body) {
  const data = parse(body, { partial: true });
  const doc = await SavedPlace.findOne({ _id: id, customerId });
  if (!doc) throw new AppError('PLACE_NOT_FOUND', 'Ünvan tapılmadı', 404);
  if (data.kind && data.kind !== doc.kind && (data.kind === 'home' || data.kind === 'work')) {
    // Başqa ünvan Ev/İş edilir: köhnə Ev/İş silinir (hər biri birdir)
    await SavedPlace.deleteMany({ customerId, kind: data.kind, _id: { $ne: doc._id } });
  }
  Object.assign(doc, data);
  if (doc.kind === 'other' && !doc.name && !doc.label) {
    throw new AppError('PLACE_NAME_REQUIRED', 'Ünvana ad verin', 400);
  }
  await doc.save();
  return publicPlace(doc);
}

async function remove(customerId, id) {
  const r = await SavedPlace.deleteOne({ _id: id, customerId });
  if (!r.deletedCount) throw new AppError('PLACE_NOT_FOUND', 'Ünvan tapılmadı', 404);
  return { removed: true };
}

/** Ünvan sifarişdə istifadə olundu: axtarışda yuxarı çıxsın. */
async function touch(customerId, id) {
  await SavedPlace.updateOne({ _id: id, customerId }, { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } });
  return { ok: true };
}

module.exports = { list, create, update, remove, touch, publicPlace, MAX_PLACES };
