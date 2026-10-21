/**
 * Qazanc jurnalını (TripEarning) əl ilə yenidən doldurur. Təhlükəsizdir: mövcud qeydlərə toxunmur.
 * İşlətmək: node scripts/backfill-earnings.js   (Heroku: heroku run node scripts/backfill-earnings.js)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const { backfillEarnings } = require('../src/services/earnings.service');

(async () => {
  await mongoose.connect(config.mongoUri);
  await backfillEarnings();
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
