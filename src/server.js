const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./utils/errors');
const { attachWebsocket } = require('./websocket');
const { seedDefaults } = require('./services/settings.service');
const { startDispatchLoop, stopDispatchLoop } = require('./queues/dispatchLoop');

const app = express();
// Heroku (and most reverse proxies) sets X-Forwarded-For. express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR unless Express trusts that header.
// 1 = trust the first proxy hop only (the Heroku router).
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
// /health limitdən kənardadır: monitorinq/load balancer sorğuları kvotanı yemir.
app.use('/health', require('./routes/health.routes'));
// "Yeniliklər" şəkilləri: statik, uzun keşlənir, limitdən kənar
app.use('/app/news-images', require('./routes/app.routes').images);
// Limit giriş etmiş istifadəçi üzrə hesablanır (token imzası yoxlanılır). Mobil operatorlarda (CGNAT) onlarla sürücü
// eyni IP ilə çıxır və hər sürücü tətbiqi dəqiqədə ~25 sorğu göndərir: yalnız IP üzrə limit hamısını bloklayardı.
// Token yoxdursa/etibarsızdırsa IP üzrə qalır.
const globalKey = (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const { sub } = jwt.verify(h.slice(7), config.jwt.accessSecret);
      if (sub) return `u:${sub}`;
    } catch (_) { /* IP-yə düş */ }
  }
  return `ip:${req.ip}`;
};
app.use(rateLimit({
  windowMs: 60_000,
  max: 300,
  keyGenerator: globalKey,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: true },
}));

app.get('/', (req, res) => {
  res.json({
    success: true,
    data: { service: 'taxi-backend', health: '/health' },
    error: null,
    meta: {},
  });
});
app.use('/app', require('./routes/app.routes'));
app.use('/auth', require('./routes/auth.routes'));
app.use('/customers', require('./routes/customer.routes'));
app.use('/drivers', require('./routes/driver.routes'));
app.use('/admin', require('./routes/admin.routes'));

app.use(notFoundHandler);
app.use(errorHandler);

const server = http.createServer(app);
let io = null;

async function start() {
  config.validateConfig();
  io = attachWebsocket(server);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  await seedDefaults();
  await require('./services/city.service').seedCities().catch((e) => console.error('[city] seed failed', e));
  await require('./services/pricing.service').migrateLegacyVehicleTypes().catch((e) => console.error('[pricing] migrate failed', e));
  // Qazanc jurnalı köhnə sifarişlərdən bir dəfə doldurulur (xəta serverin qalxmasına mane olmasın)
  await require('./services/earnings.service').backfillOnce().catch((e) => console.error('[earnings] backfill failed', e));
  await new Promise((resolve) => server.listen(config.port, resolve));
  console.log(`taxi-backend listening on :${config.port}`);
  startDispatchLoop();
  // Planlaşdırılmış "Yeniliklər" vaxtı çatanda sürücülərə göndərilir
  require('./services/news.service').startScheduler();
}

let shuttingDown = false;
/**
 * Graceful shutdown (deploy/restart zamanı SIGTERM): yeni sorğular qəbul edilmir, dispatch loop-un cari tick-i
 * bitir, açıq sorğular tamamlanır, sonra baza bağlanır. Yarımçıq qalan sifarişlər bazada olduğu üçün
 * növbəti instansiya onları qaldığı yerdən davam etdirir.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} alındı`);
  const force = setTimeout(() => {
    console.error('[shutdown] vaxt bitdi, məcburi çıxış');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  force.unref();
  try {
    await stopDispatchLoop();
    require('./services/news.service').stopScheduler();
    if (io) await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('[shutdown] xəta', e);
    process.exit(1);
  }
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Tutulmamış xəta prosesi səssiz çökdürməsin: səbəb loglanır; uncaughtException-da vəziyyət etibarsızdır, yenidən başlayır.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
    shutdown('uncaughtException');
  });
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { app, server, start, shutdown };
