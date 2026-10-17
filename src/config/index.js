require('dotenv').config();

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

const DEV_SECRETS = new Set(['dev-access', 'dev-refresh', 'dev-otp']);

const config = {
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
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : '*',
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000),
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

/**
 * Production-da təhlükəli/natamam konfiqurasiya ilə serverin qalxmasının qarşısını alır.
 * (Əvvəl default "dev-access" açarı ilə istənilən şəxs token saxtalaşdıra bilərdi.)
 */
function validateConfig(cfg = config) {
  if (!isProd) return;
  const problems = [];
  if (!process.env.MONGODB_URI) problems.push('MONGODB_URI təyin edilməyib');
  for (const [name, value] of [
    ['JWT_ACCESS_SECRET', cfg.jwt.accessSecret],
    ['JWT_REFRESH_SECRET', cfg.jwt.refreshSecret],
  ]) {
    if (!value || DEV_SECRETS.has(value) || value.length < 32) {
      problems.push(`${name} təyin edilməyib və ya zəifdir (ən azı 32 simvol olmalıdır)`);
    }
  }
  if (cfg.jwt.accessSecret === cfg.jwt.refreshSecret) {
    problems.push('JWT_ACCESS_SECRET və JWT_REFRESH_SECRET fərqli olmalıdır');
  }
  if (!process.env.SMS_API_KEY) problems.push('SMS_API_KEY təyin edilməyib (OTP göndərilə bilməz)');
  if (problems.length) {
    throw new Error(`Yanlış production konfiqurasiyası:\n - ${problems.join('\n - ')}`);
  }
  if (!process.env.OTP_SECRET) {
    console.warn('[config] OTP_SECRET təyin edilməyib: JWT_ACCESS_SECRET istifadə olunur (ayrıca açar tövsiyə olunur)');
  }
  if (cfg.corsOrigin === '*') {
    console.warn('[config] CORS_ORIGIN təyin edilməyib: bütün origin-lərə icazə verilir');
  }
}

module.exports = config;
module.exports.validateConfig = validateConfig;
