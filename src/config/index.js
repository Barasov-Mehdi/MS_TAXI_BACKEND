require('dotenv').config();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/taxi',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
