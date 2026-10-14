const dispatchService = require('../services/dispatch.service');

// Sürücüyə ayrılan müddət (default 20 san) bitən sifarişləri tapıb növbəti sürücüyə keçirir,
// 3 dəqiqə dolan sifarişləri ləğv edir və konumu köhnəlmiş boş sürücüləri offline edir.
//
// DİQQƏT: bu loop web serverin içində (server.js) işləməlidir, ayrıca worker prosesində yox.
// Socket.IO hadisələri (new_order, order_offer_expired ...) yalnız `io` olan prosesdən sürücülərə çata bilər.
// Bir neçə web instansiya eyni anda işləsə belə problem yoxdur: dispatchSeq (optimistic lock) təkrar irəli keçməni əngəlləyir.
const DISPATCH_TICK_MS = Number(process.env.DISPATCH_TICK_MS || 500);
const STALE_SWEEP_MS = Number(process.env.STALE_DRIVER_SWEEP_MS || 15000);

let timer = null;
let sweepTimer = null;
let running = false;
let sweeping = false;
let inFlight = Promise.resolve();

function startDispatchLoop() {
  if (timer) return timer;

  timer = setInterval(() => {
    if (running) return; // əvvəlki tick bitməyibsə üst-üstə düşməsin
    running = true;
    inFlight = (async () => {
      try {
        await dispatchService.processDueOrders();
      } catch (e) {
        console.error('dispatch loop failed', e);
      } finally {
        running = false;
      }
    })();
  }, DISPATCH_TICK_MS);
  timer.unref();

  sweepTimer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await dispatchService.sweepStaleDrivers();
    } catch (e) {
      console.error('stale driver sweep failed', e);
    } finally {
      sweeping = false;
    }
  }, STALE_SWEEP_MS);
  sweepTimer.unref();

  return timer;
}

/** Loop-u dayandırır və cari tick-in bitməsini gözləyir (graceful shutdown üçün). */
async function stopDispatchLoop() {
  if (timer) clearInterval(timer);
  if (sweepTimer) clearInterval(sweepTimer);
  timer = null;
  sweepTimer = null;
  await inFlight;
}

module.exports = { startDispatchLoop, stopDispatchLoop };
