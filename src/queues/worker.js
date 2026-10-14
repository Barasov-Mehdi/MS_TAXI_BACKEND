require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const dispatchService = require('../services/dispatch.service');

// Qeyd: sifariş dispatch-i (sürücüyə 20 san, növbəti sürücüyə keçid, 3 dəq ləğv) və köhnəlmiş sürücülərin
// offline edilməsi artıq web serverin içində (queues/dispatchLoop.js) işləyir - çünki yalnız orada Socket.IO əlçatandır.
// Bu fayl ayrıca prosesdə işlədilərsə, yalnız sürücü sweep-ini təkrarlayır (təhlükəsizdir: əməliyyat idempotentdir,
// lakin bildirişlər yalnız web prosesindən gedə bildiyi üçün tövsiyə olunan yol web prosesinə güvənməkdir).

const markStaleDrivers = () => dispatchService.sweepStaleDrivers();

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
