/**
 * express-rate-limit üçün paylaşılan sayğac. Redis varsa bütün instansiyalar EYNİ sayğacı görür
 * (əks halda 4 dyno → limit faktiki 4 dəfə böyük olur). Redis yoxdursa undefined → yaddaş (tək instansiya).
 */
const redis = require('./redis');

const COMMAND_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 800);

function makeStore(prefix) {
  const client = redis.getClient();
  if (!client) return undefined;
  try {
    // eslint-disable-next-line global-require
    const { RedisStore } = require('rate-limit-redis');
    const store = new RedisStore({
      prefix: `rl:${prefix}:`,
      // Redis əlçatan deyilsə sorğu asılı qalmasın: 800 ms sonra xəta → passOnStoreError sorğunu buraxır.
      // Skript yüklənməsi alınmasa paket növbəti sorğuda özü yenidən yükləyir (Redis qalxanda limit bərpa olunur).
      sendCommand: (...args) => {
        const p = client.sendCommand(args);
        let t;
        const timeout = new Promise((_, reject) => {
          t = setTimeout(() => reject(new Error('REDIS_TIMEOUT')), COMMAND_TIMEOUT_MS);
        });
        return Promise.race([p, timeout]).finally(() => clearTimeout(t));
      },
    });
    // Başlanğıcda Redis hələ qoşulmayıbsa skript yüklənməsinin xətası "unhandled rejection" olmasın
    [store.incrementScriptSha, store.getScriptSha].forEach((pr) => pr && pr.catch && pr.catch(() => {}));
    return store;
  } catch (e) {
    console.error('[rate-limit] Redis store yaradılmadı, yaddaş istifadə olunur:', e && e.message);
    return undefined;
  }
}

module.exports = { makeStore };
