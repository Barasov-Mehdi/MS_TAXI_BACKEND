const dispatchService = require('../services/dispatch.service');

// Sürücüyə ayrılan müddət (25 san) bitən sifarişləri tapıb növbəti sürücüyə keçirir və
// 3 dəqiqə dolan sifarişləri ləğv edir.
//
// DİQQƏT: bu loop web serverin içində (server.js) işləməlidir, ayrıca worker prosesində yox.
// Socket.IO hadisələri (new_order, order_offer_expired ...) yalnız `io` olan prosesdən sürücülərə çata bilər.
// Bir neçə web instansiya eyni anda işləsə belə problem yoxdur: dispatchSeq (optimistic lock) təkrar irəli keçməni əngəlləyir.
const DISPATCH_TICK_MS = Number(process.env.DISPATCH_TICK_MS || 500);

let timer = null;
let running = false;

function startDispatchLoop() {
  if (timer) return timer;
  timer = setInterval(async () => {
    if (running) return; // əvvəlki tick bitməyibsə üst-üstə düşməsin
    running = true;
    try {
      await dispatchService.processDueOrders();
    } catch (e) {
      console.error('dispatch loop failed', e);
    } finally {
      running = false;
    }
  }, DISPATCH_TICK_MS);
  timer.unref();
  return timer;
}

function stopDispatchLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startDispatchLoop, stopDispatchLoop };
