/**
 * Bütün modellərin indekslərini bazada qurur / yeniləyir (deploy zamanı bir dəfə).
 * Heroku: Procfile → `release: node scripts/sync-indexes.js` (hər deploy-da avtomatik).
 * Böyük kolleksiyada server açılışını yubatmamaq üçün production-da MONGO_AUTO_INDEX=false qoyun.
 *
 * Qeyd: syncIndexes kodda olmayan indeksləri SİLMİR (dropExtra=false) — admin əl ilə yaratdığı indekslər qalır.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const models = require('../src/models');

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  const names = Object.keys(models).filter((k) => models[k] && models[k].schema);
  for (const name of names) {
    const model = models[name];
    const started = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await model.createIndexes();
    console.log(`[indexes] ${name}: hazır (${Date.now() - started} ms)`);
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('[indexes] xəta', e);
  process.exit(1);
});
