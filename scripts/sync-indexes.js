/**
 * Bütün modellərin indekslərini bazada qurur (deploy zamanı bir dəfə).
 * Heroku: Procfile → `release: node scripts/sync-indexes.js` (hər deploy-da avtomatik).
 * Böyük kolleksiyada server açılışını yubatmamaq üçün production-da MONGO_AUTO_INDEX=false qoyun.
 *
 * Hər indeks AYRICA qurulur:
 *  - bazada eyni adlı, amma fərqli seçimli indeks varsa (məs. köhnədən qalmış unique `users.phone_1`) ona
 *    TOXUNULMUR, xəbərdarlıq yazılır və növbəti indeksə keçilir (əvvəl bu, bütün deploy-u dayandırırdı);
 *  - kodda olmayan indekslər SİLİNMİR.
 * Skript yalnız baza bağlantısı alınmayanda xəta ilə bitir (deploy dayanır), indeks ziddiyyətində yox.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const models = require('../src/models');

// Eyni ad / açar, fərqli seçimlər: mövcud indeks saxlanılır
const CONFLICT_CODES = new Set([85, 86]); // IndexOptionsConflict, IndexKeySpecsConflict

async function syncModel(name, model) {
  const collection = model.collection;
  let created = 0;
  let kept = 0;
  for (const [fields, options] of model.schema.indexes()) {
    const opts = { background: true, ...(options || {}) };
    try {
      // eslint-disable-next-line no-await-in-loop
      await collection.createIndex(fields, opts);
      created += 1;
    } catch (e) {
      if (e && CONFLICT_CODES.has(e.code)) {
        kept += 1;
        console.warn(
          `[indexes] ${name} ${JSON.stringify(fields)}: bazada fərqli seçimlərlə artıq var — toxunulmadı (${e.codeName})`
        );
      } else {
        throw e;
      }
    }
  }
  return { created, kept };
}

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  const names = Object.keys(models).filter((k) => models[k] && models[k].schema && models[k].collection);
  let failed = 0;
  for (const name of names) {
    const started = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await syncModel(name, models[name]);
      console.log(`[indexes] ${name}: ${r.created} hazır${r.kept ? `, ${r.kept} köhnə saxlanıldı` : ''} (${Date.now() - started} ms)`);
    } catch (e) {
      // Bir modelin gözlənilməz xətası digərlərinə və deploy-a mane olmasın
      failed += 1;
      console.error(`[indexes] ${name}: xəta`, e && e.message);
    }
  }
  await mongoose.disconnect();
  if (failed) console.warn(`[indexes] ${failed} modeldə xəta oldu (yuxarıya baxın); deploy davam edir`);
}

main().catch((e) => {
  // Yalnız bağlantı xətası: bazaya qoşulmaq olmursa yeni versiya da işləməyəcək — deploy dayansın
  console.error('[indexes] bazaya qoşulmaq alınmadı', e);
  process.exit(1);
});
