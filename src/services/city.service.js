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


/** Şəhər/rayon mərkəzlərinin təxmini koordinatları [lat, lng]. Admin paneldən düzəltmək olar. */
const CENTERS = {
  'Bakı': [40.4093, 49.8671], 'Sumqayıt': [40.5897, 49.6686], 'Gəncə': [40.6828, 46.3606], 'Mingəçevir': [40.77, 47.0489],
  'Şirvan': [39.9317, 48.9203], 'Naxçıvan': [39.2089, 45.4122], 'Lənkəran': [38.7543, 48.8506], 'Şəki': [41.1919, 47.1706],
  'Yevlax': [40.6172, 47.15], 'Naftalan': [40.5067, 46.825], 'Xankəndi': [39.8153, 46.7519], 'Şuşa': [39.76, 46.7497],
  'Xırdalan': [40.4481, 49.7556], 'Abşeron': [40.47, 49.68], 'Ağcabədi': [40.0528, 47.4597], 'Ağdam': [39.9911, 46.93],
  'Ağdaş': [40.6469, 47.4769], 'Ağstafa': [41.1189, 45.4539], 'Ağsu': [40.5708, 48.4008], 'Astara': [38.456, 48.875],
  'Babək': [39.15, 45.45], 'Balakən': [41.7258, 46.4083], 'Beyləqan': [39.7756, 47.6186], 'Bərdə': [40.3747, 47.1264],
  'Biləsuvar': [39.4583, 48.545], 'Cəbrayıl': [39.4, 47.0264], 'Cəlilabad': [39.2092, 48.4919], 'Culfa': [38.9558, 45.6308],
  'Daşkəsən': [40.5203, 46.0778], 'Füzuli': [39.6003, 47.1453], 'Gədəbəy': [40.57, 45.8106], 'Goranboy': [40.6103, 46.7897],
  'Göyçay': [40.6531, 47.7406], 'Göygöl': [40.5872, 46.3189], 'Hacıqabul': [40.0394, 48.9203], 'Xaçmaz': [41.4635, 48.806],
  'Xızı': [40.9108, 49.0711], 'Xocalı': [39.9133, 46.79], 'Xocavənd': [39.795, 47.11], 'İmişli': [39.8697, 48.06],
  'İsmayıllı': [40.7872, 48.1519], 'Kəlbəcər': [40.105, 46.0383], 'Kəngərli': [39.395, 45.16], 'Kürdəmir': [40.3383, 48.1608],
  'Qax': [41.4225, 46.9242], 'Qazax': [41.0928, 45.3656], 'Qəbələ': [40.9814, 47.8458], 'Qobustan': [40.5328, 48.9283],
  'Quba': [41.3611, 48.5133], 'Qubadlı': [39.3439, 46.5794], 'Qusar': [41.4275, 48.4302], 'Laçın': [39.6408, 46.5469],
  'Lerik': [38.7739, 48.415], 'Masallı': [39.0342, 48.6658], 'Neftçala': [39.3586, 49.2469], 'Oğuz': [41.0728, 47.465],
  'Ordubad': [38.9081, 46.0278], 'Saatlı': [39.9322, 48.3689], 'Sabirabad': [40.0128, 48.4789], 'Salyan': [39.5961, 48.9847],
  'Samux': [40.7647, 46.4067], 'Sədərək': [39.71, 44.88], 'Siyəzən': [41.0778, 49.1125], 'Şabran': [41.2156, 48.9875],
  'Şahbuz': [39.4072, 45.5739], 'Şamaxı': [40.6303, 48.6414], 'Şəmkir': [40.8297, 46.0169], 'Şərur': [39.5536, 44.9847],
  'Tərtər': [40.345, 46.9289], 'Tovuz': [40.9922, 45.6283], 'Ucar': [40.5186, 47.6542], 'Yardımlı': [38.9069, 48.2403],
  'Zaqatala': [41.6336, 46.6433], 'Zəngilan': [39.0858, 46.6525], 'Zərdab': [40.2186, 47.7083],
};

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
  // Koordinatı olmayan şəhərlərə mərkəz yazılır (admin dəyişibsə toxunulmur)
  for (const name of DEFAULT_CITIES) {
    const c = CENTERS[name];
    if (!c) continue;
    ops.push({
      updateOne: {
        filter: { nameLower: lower(name), $or: [{ 'center.lat': null }, { 'center.lat': { $exists: false } }] },
        update: { $set: { 'center.lat': c[0], 'center.lng': c[1] } },
      },
    });
  }
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

// ---- Nöqtə → ən yaxın şəhər (5 dəq keş) ----
let cache = { at: 0, list: [] };
async function centers() {
  if (Date.now() - cache.at < 5 * 60 * 1000) return cache.list;
  const list = await City.find({ isActive: true, 'center.lat': { $ne: null } }).select('name center radiusKm').lean();
  cache = { at: Date.now(), list };
  return list;
}
function invalidateCenters() {
  cache.at = 0;
}

function distKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Götürmə nöqtəsinə ən yaxın (radius daxilində) şəhər; yoxdursa null. */
async function cityForPoint(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  let best = null;
  for (const c of await centers()) {
    const d = distKm(Number(lat), Number(lng), c.center.lat, c.center.lng);
    if (d <= (c.radiusKm || 50) && (!best || d < best.d)) best = { id: c._id, name: c.name, d };
  }
  return best;
}

module.exports = {
  cityForPoint,
  invalidateCenters,
  distKm,
  CENTERS, seedCities, publicCity, listActive, requireActiveCity, getCity, DEFAULT_CITIES };
