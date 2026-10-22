const mongoose = require('mongoose');
const { City } = require('../models');
const { AppError } = require('../utils/errors');

/**
 * Azərbaycanın bütün şəhər və rayonları (Naxçıvan MR daxil).
 * Əvvəl böyük şəhərlər, sonra qalanları əlifba ilə. Baş admin istəmədiyini deaktiv edə bilər.
 */
const MAIN_CITIES = [
  'Bakı', 'Sumqayıt', 'Gəncə', 'Mingəçevir', 'Şirvan', 'Naxçıvan', 'Lənkəran', 'Şəki',
  'Yevlax', 'Naftalan', 'Xankəndi', 'Şuşa', 'Xırdalan',
];

const DISTRICTS = [
  // Rayonlar
  'Abşeron', 'Ağcabədi', 'Ağdam', 'Ağdaş', 'Ağstafa', 'Ağsu', 'Astara', 'Balakən', 'Beyləqan', 'Bərdə',
  'Biləsuvar', 'Cəbrayıl', 'Cəlilabad', 'Daşkəsən', 'Füzuli', 'Gədəbəy', 'Goranboy', 'Göyçay', 'Göygöl',
  'Hacıqabul', 'İmişli', 'İsmayıllı', 'Kəlbəcər', 'Kürdəmir', 'Laçın', 'Lerik', 'Masallı', 'Neftçala',
  'Oğuz', 'Qax', 'Qazax', 'Qəbələ', 'Qobustan', 'Quba', 'Qubadlı', 'Qusar', 'Saatlı', 'Sabirabad',
  'Salyan', 'Samux', 'Siyəzən', 'Şabran', 'Şamaxı', 'Şəmkir', 'Tərtər', 'Tovuz', 'Ucar', 'Xaçmaz',
  'Xızı', 'Xocalı', 'Xocavənd', 'Yardımlı', 'Zaqatala', 'Zəngilan', 'Zərdab',
  // Naxçıvan Muxtar Respublikası
  'Babək', 'Culfa', 'Kəngərli', 'Ordubad', 'Sədərək', 'Şahbuz', 'Şərur',
];

const DEFAULT_CITIES = [
  ...MAIN_CITIES,
  ...DISTRICTS.filter((n) => !MAIN_CITIES.includes(n)).sort((x, y) => x.localeCompare(y, 'az')),
];

const lower = (n) => String(n).trim().toLocaleLowerCase('az');

/**
 * Siyahıda olub bazada olmayan şəhərləri əlavə edir (hər qalxışda; mövcudlara toxunmur,
 * baş adminin deaktiv etdiyi şəhər yenidən aktivləşmir).
 */
async function seedCities() {
  const ops = DEFAULT_CITIES.map((name, i) => ({
    updateOne: {
      filter: { nameLower: lower(name) },
      update: { $setOnInsert: { name, nameLower: lower(name), sortOrder: i + 1, isActive: true } },
      upsert: true,
    },
  }));
  try {
    const r = await City.bulkWrite(ops, { ordered: false });
    if (r.upsertedCount) console.log(`[city] ${r.upsertedCount} yeni şəhər/rayon əlavə olundu`);
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