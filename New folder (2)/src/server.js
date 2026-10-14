const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const config = require('./config');
const { errorHandler } = require('./utils/errors');
const { attachWebsocket } = require('./websocket');
const { seedDefaults } = require('./services/settings.service');

const app = express();
// Heroku (and most reverse proxies) sets X-Forwarded-For. express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR unless Express trusts that header.
// 1 = trust the first proxy hop only (the Heroku router).
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
app.use(rateLimit({
  windowMs: 60_000,
  max: 300,
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
app.use('/health', require('./routes/health.routes'));
app.use('/auth', require('./routes/auth.routes'));
app.use('/customers', require('./routes/customer.routes'));
app.use('/drivers', require('./routes/driver.routes'));
app.use('/admin', require('./routes/admin.routes'));

app.use(errorHandler);

const server = http.createServer(app);
attachWebsocket(server);

async function start() {
  await mongoose.connect(config.mongoUri);
  await seedDefaults();
  server.listen(config.port, () => {
    console.log(`taxi-backend listening on :${config.port}`);
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { app, server, start }; 