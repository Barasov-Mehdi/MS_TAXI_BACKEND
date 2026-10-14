require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

module.exports = {
  env,
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/taxi',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh',
    // Giriş nömrə ilə olduğu üçün access token qısa qalır, refresh token isə 30 gün.
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },
  corsOrigin: process.env.CORS_ORIGIN || '*',
  otp: {
    // OTP kodunun hash-lənməsi üçün gizli açar (yoxdursa JWT açarından istifadə olunur)
    secret: process.env.OTP_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-otp',
    ttlSec: Number(process.env.OTP_TTL_SEC || 300),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
    resendCooldownSec: Number(process.env.OTP_RESEND_COOLDOWN_SEC || 60),
    maxSendsPerHour: Number(process.env.OTP_MAX_SENDS_PER_HOUR || 5),
  },
  sms: {
    // 1sms.az API açarı. Boşdursa və NODE_ENV=production deyilsə, kod yalnız konsola yazılır.
    apiKey: process.env.SMS_API_KEY || '',
    url: process.env.SMS_API_URL || 'https://1sms.az/api/v1/sms/otp',
    senderName: process.env.SMS_SENDER_NAME || '1sms.az',
    timeoutMs: Number(process.env.SMS_TIMEOUT_MS || 10000),
  },
};
