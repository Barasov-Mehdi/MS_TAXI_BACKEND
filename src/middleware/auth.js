const jwt = require('jsonwebtoken');
const config = require('../config');
const { User, Customer, Driver } = require('../models');
const { AppError } = require('../utils/errors');

/**
 * Native cihaz tokeni (scope=device) yalnız bu endpoint-lərdə qəbul olunur.
 * Məqsəd: tətbiq arxa planda / ekran kilidli olanda (JS taymerləri dayanır, 15 dəqiqəlik access token yenilənmir)
 * Kotlin tərəfi sifarişi qəbul/rədd edə və mövqe göndərə bilsin.
 */
const DEVICE_ROUTES = [
  { method: 'POST', re: /^\/drivers\/location\/?$/ },
  { method: 'POST', re: /^\/drivers\/orders\/[0-9a-fA-F]{24}\/accept\/?$/ },
  { method: 'POST', re: /^\/drivers\/orders\/[0-9a-fA-F]{24}\/reject\/?$/ },
  { method: 'POST', re: /^\/drivers\/device-token\/?$/ },
  { method: 'GET', re: /^\/drivers\/offers\/current\/?$/ },
];

function deviceRouteAllowed(req) {
  const path = (req.originalUrl || '').split('?')[0];
  return DEVICE_ROUTES.some((r) => r.method === req.method && r.re.test(path));
}

function verifyToken(token) {
  try {
    return { payload: jwt.verify(token, config.jwt.accessSecret), scope: 'access' };
  } catch (e) {
    // Access token deyil: cihaz tokeni ola bilər (fərqli imza açarı)
    try {
      const payload = jwt.verify(token, `${config.jwt.accessSecret}:device`);
      if (payload && payload.scope === 'device' && payload.sid) return { payload, scope: 'device' };
    } catch (_) {}
    throw e;
  }
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('UNAUTHORIZED', 'Missing token', 401);
    const { payload, scope } = verifyToken(token);
    if (scope === 'device' && !deviceRouteAllowed(req)) {
      throw new AppError('UNAUTHORIZED', 'Device token not allowed here', 401);
    }
    const user = await User.findById(payload.sub);
    if (!user) throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
    if (!user.isActive) {
      // Sərnişin tətbiqi bu kodu tanıyır və "hesab bloklanıb" izahını göstərir
      if (user.role === 'CUSTOMER') throw new AppError('USER_DISABLED', 'Hesab deaktiv edilib', 403);
      throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
    }
    req.user = user;
    req.authScope = scope;
    if (user.role === 'CUSTOMER') {
      if (scope === 'device') throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
      req.customer = await Customer.findOne({ userId: user._id });
      if (!req.customer) throw new AppError('PROFILE_NOT_FOUND', 'Customer profile not found', 403);
    }
    if (user.role === 'DRIVER') {
      const q = Driver.findOne({ userId: user._id });
      if (scope === 'device') q.select('+deviceSessionId');
      req.driver = await q;
      if (!req.driver) throw new AppError('PROFILE_NOT_FOUND', 'Driver profile not found', 403);
      if (scope === 'device') {
        // Çıxış edilib və ya daha yeni cihaz tokeni alınıb: köhnə token etibarsızdır
        if (!req.driver.deviceSessionId || req.driver.deviceSessionId !== payload.sid) {
          throw new AppError('UNAUTHORIZED', 'Device session revoked', 401);
        }
      }
    }
    if (scope === 'device' && user.role !== 'DRIVER') {
      throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
    }
    next();
  } catch (e) {
    if (e instanceof AppError) return next(e);
    next(new AppError('UNAUTHORIZED', 'Invalid token', 401));
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('FORBIDDEN', 'Insufficient role', 403));
    }
    next();
  };
}

module.exports = { authenticate, requireRoles };
