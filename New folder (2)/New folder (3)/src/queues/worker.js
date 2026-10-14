require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const { Driver } = require('../models');
const { getSettings } = require('../services/settings.service');

// Qeyd: sifariş dispatch-i (sürücüyə 25 san, növbəti sürücüyə keçid, 3 dəq ləğv) burada DEYİL,
// web serverin içində (queues/dispatchLoop.js) işləyir - çünki yalnız orada Socket.IO əlçatandır.

async function markStaleDrivers() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - (settings.driverLocationStaleSeconds || 45) * 1000);
  await Driver.updateMany(
    { isOnline: true, locationUpdatedAt: { $lt: cutoff } },
    { $set: { isOnline: false } }
  );
}

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('worker connected');
  setInterval(() => {
    markStaleDrivers().catch((e) => console.error(e));
  }, 15000);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { markStaleDrivers };
