const mongoose = require('mongoose');
const { City } = require('../models');
const { AppError } = require('../utils/errors');

/** İlk qalxışda (şəhər yoxdursa) əlavə olunan şəhərlər. Baş admin sonradan əlavə edə / deaktiv edə bilər. */
const DEFAULT_CITIES = [
  'Bakı', 'Sumqayıt', 'Gəncə', 'Mingəçevir', 'Şirvan', 'Naxçıvan', 'Lənkəran', 'Şəki',
  'Zaqatala', 'Qəbələ', 'Quba', 'Xaçmaz', 'Şamaxı', 'Bərdə', 'Yevlax', 'Qax', 'Balakən',
];

async function seedCities() {
  if ((await City.estimatedDocumentCount()) > 0) return;
  const docs = DEFAULT_CITIES.map((name, i) => ({ name, nameLower: name.toLocaleLowerCase('az'), sortOrder: i + 1 }));
  try {
    await City.insertMany(docs, { ordered: false });
    console.log(`[city] ${docs.length} şəhər əlavə olundu`);
  } catch (e) {
    // Paralel qalxışda dublikat: problem deyil
    if (!(e && (e.code === 11000 || (e.writeErrors || []).every((w) => w.code === 11000)))) throw e;
  }
}

/** Sürücü tətbiqinə / qeydiyyat formasına göstərilən sahələr. */
function publicCity(c) {
  if (!c) return null;
  return {
    _id: c._id,
    name: c.name,
    officeAddress: c.officeAddress || '',
    officePhone: c.officePhone || '',
    workHours: c.workHours || '',
  };
}

async function listActive() {
  const cities = await City.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
  return cities.map(publicCity);
}

const isId = (v) => typeof v === 'string' ? mongoose.isValidObjectId(v) : !!v && mongoose.isValidObjectId(String(v));

/** Seçilən şəhər mövcud və aktiv olmalıdır. */
async function requireActiveCity(cityId) {
  if (!cityId || !isId(cityId)) throw new AppError('CITY_REQUIRED', 'Şəhərinizi seçin', 400);
  const city = await City.findById(cityId).lean();
  if (!city || !city.isActive) throw new AppError('CITY_NOT_FOUND', 'Seçilən şəhər tapılmadı', 400);
  return city;
}

async function getCity(cityId) {
  if (!cityId || !isId(cityId)) return null;
  return City.findById(cityId).lean();
}

module.exports = { seedCities, publicCity, listActive, requireActiveCity, getCity, DEFAULT_CITIES };
