const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, Customer, Driver, RefreshToken } = require('../models');
const config = require('../config');
const { AppError } = require('../utils/errors');
const { AuditLog } = require('../models');
const otpService = require('./otp.service');
const { normalizePhone } = require('../utils/validators');

function signAccess(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefresh(user) {
  const raw = crypto.randomBytes(48).toString('hex');
  const ttlMs = 30 * 24 * 3600 * 1000;
  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return raw;
}

async function register({ role, phone, password, firstName, lastName, email, code }) {
  if (!['CUSTOMER', 'DRIVER'].includes(role)) {
    throw new AppError('INVALID_ROLE', 'Role must be CUSTOMER or DRIVER', 400);
  }
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError('VALIDATION_ERROR', 'Telefon nömrəsi düzgün deyil', 400);
  phone = normalized;
  const exists = await User.findOne({ phone });
  if (exists) throw new AppError('PHONE_TAKEN', 'Phone already registered', 409);
  // Nömrə SMS kodu ilə təsdiqlənməlidir (kod /auth/register/otp ilə göndərilir; təkistifadəlikdir).
  await otpService.verifyOtp(phone, String(code || ''), 'register');
  const passwordHash = await User.hashPassword(password);
  let user;
  try {
    user = await User.create({ role, phone, passwordHash, firstName, lastName, email, phoneVerified: true });
  } catch (e) {
    if (e && e.code === 11000) throw new AppError('PHONE_TAKEN', 'Phone already registered', 409);
    throw e;
  }
  if (role === 'CUSTOMER') await Customer.create({ userId: user._id });
  if (role === 'DRIVER') await Driver.create({ userId: user._id, isVerified: false });
  return user;
}

/** Qeydiyyat üçün SMS kodu göndərir. Nömrə artıq qeydiyyatdadırsa kod göndərilmir. */
async function requestRegisterOtp(phoneInput) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new AppError('VALIDATION_ERROR', 'Telefon nömrəsi düzgün deyil', 400);
  if (await User.findOne({ phone })) throw new AppError('PHONE_TAKEN', 'Phone already registered', 409);
  const result = await otpService.requestOtp(phone, 'register');
  return { sent: true, phone, ...result }; // devCode yalnız SMS açarı olmayan inkişaf mühitində
}

/** Giriş üçün nömrəni normallaşdırır; köhnə (normallaşdırılmamış) qeydləri də tapır. */
async function findUserByPhone(input) {
  const raw = String(input || '').trim();
  const normalized = normalizePhone(raw);
  if (normalized) {
    const u = await User.findOne({ phone: normalized });
    if (u) return u;
  }
  return raw ? User.findOne({ phone: raw }) : null;
}

async function login({ phone, password, ip }) {
  const user = await findUserByPhone(phone);
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid phone or password', 401);
  }
  if (!user.isActive) throw new AppError('USER_DISABLED', 'Account disabled', 403);
  await AuditLog.create({ actorId: user._id, actorRole: user.role, action: 'LOGIN', ip });
  return {
    accessToken: signAccess(user),
    refreshToken: await issueRefresh(user),
    user: publicUser(user),
  };
}

/**
 * Nömrə + OTP ilə giriş. Nömrə qeydiyyatda yoxdursa hesab avtomatik yaradılır
 * (ad, username, email sonradan profildən əlavə olunur).
 */
async function loginWithOtp({ phone, code, ip }) {
  await otpService.verifyOtp(phone, code);

  let user = await User.findOne({ phone });
  let isNewUser = false;

  if (user) {
    if (user.role !== 'CUSTOMER') {
      throw new AppError('ROLE_NOT_ALLOWED', 'Bu nömrə sərnişin hesabı deyil', 403);
    }
    if (!user.isActive) throw new AppError('USER_DISABLED', 'Hesab deaktiv edilib', 403);
    if (!user.phoneVerified) {
      user.phoneVerified = true;
      await user.save();
    }
  } else {
    try {
      user = await User.create({ role: 'CUSTOMER', phone, phoneVerified: true });
      isNewUser = true;
    } catch (e) {
      if (!(e && e.code === 11000)) throw e;
      user = await User.findOne({ phone }); // paralel qeydiyyat
      if (!user) throw e;
    }
  }

  // Əvvəlki yarımçıq qeydiyyat halında da Customer sənədi olsun.
  await Customer.updateOne({ userId: user._id }, { $setOnInsert: { userId: user._id } }, { upsert: true });

  await AuditLog.create({
    actorId: user._id,
    actorRole: user.role,
    action: isNewUser ? 'REGISTER_OTP' : 'LOGIN_OTP',
    ip,
  });
  return {
    accessToken: signAccess(user),
    refreshToken: await issueRefresh(user),
    user: publicUser(user),
    isNewUser,
  };
}

async function refresh(refreshToken) {
  if (!refreshToken) throw new AppError('INVALID_REFRESH', 'Invalid refresh token', 401);
  const tokenHash = hashToken(refreshToken);
  const row = await RefreshToken.findOne({ tokenHash, revoked: false });
  if (!row || row.expiresAt < new Date()) throw new AppError('INVALID_REFRESH', 'Invalid refresh token', 401);
  const user = await User.findById(row.userId);
  if (!user || !user.isActive) throw new AppError('INVALID_REFRESH', 'Invalid refresh token', 401);
  row.revoked = true;
  await row.save();
  return {
    accessToken: signAccess(user),
    refreshToken: await issueRefresh(user),
  };
}

async function logout(refreshToken) {
  if (!refreshToken) return;
  await RefreshToken.updateOne({ tokenHash: hashToken(refreshToken) }, { revoked: true });
}

async function verifyPhone(userId, code) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  if (user.phoneVerified) return user;
  await otpService.verifyOtp(user.phone, String(code || ''), 'verify');
  user.phoneVerified = true;
  await user.save();
  return user;
}

async function resendVerification(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  if (user.phoneVerified) return { sent: false, alreadyVerified: true };
  const result = await otpService.requestOtp(user.phone, 'verify');
  return { sent: true, ...result };
}

/**
 * Şifrə sıfırlama: kod SMS ilə gedir. Nömrənin mövcud olub-olmaması cavabdan bilinmir
 * (həmişə { sent: true }). Parol yalnız sürücü/admin hesablarında var.
 */
async function requestPasswordReset(phoneInput) {
  const user = await findUserByPhone(phoneInput);
  if (!user || !user.isActive || !user.passwordHash || user.role === 'CUSTOMER') {
    // Cavab eyni qalır (nömrə yoxlanışının qarşısı), amma səbəb serverin logunda görünür.
    const reason = !user ? 'nömrə tapılmadı' : !user.isActive ? 'hesab deaktivdir'
      : user.role === 'CUSTOMER' ? 'sərnişin hesabıdır (parolu yoxdur)' : 'parolu yoxdur';
    console.warn(`[auth] şifrə sıfırlama SMS-i göndərilmədi: ${reason} (...${String(phoneInput).slice(-4)})`);
    return { sent: true };
  }
  try {
    const result = await otpService.requestOtp(user.phone, 'reset');
    return { sent: true, ...result }; // devCode yalnız SMS açarı olmayan inkişaf mühitində gəlir
  } catch (e) {
    if (e && ['OTP_COOLDOWN', 'OTP_LIMIT'].includes(e.code)) return { sent: true };
    console.error('[auth] sıfırlama SMS-i göndərilmədi:', e && e.code ? e.code : e.message);
    return { sent: true };
  }
}

async function resetPassword({ phone: phoneInput, code, password, ip }) {
  const invalid = () => new AppError('INVALID_CODE', 'Kod səhvdir və ya vaxtı bitib', 400);
  const user = await findUserByPhone(phoneInput);
  if (!user || !user.isActive || !user.passwordHash || user.role === 'CUSTOMER') throw invalid();
  await otpService.verifyOtp(user.phone, String(code), 'reset');
  user.passwordHash = await User.hashPassword(password);
  user.passwordResetCode = null;
  user.passwordResetExpiresAt = null;
  await user.save();
  // Bütün köhnə sessiyalar bağlanır (parol oğurlanmış ola bilər).
  await RefreshToken.updateMany({ userId: user._id, revoked: false }, { revoked: true });
  await AuditLog.create({ actorId: user._id, actorRole: user.role, action: 'PASSWORD_RESET', ip });
  return { reset: true };
}

/**
 * Parolu dəyişir. Cari parol yoxlanılır; bu cihazın refresh token-i istisna olmaqla
 * bütün digər sessiyalar bağlanır.
 */
async function changePassword({ userId, currentPassword, newPassword, keepRefreshToken }) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  if (!(await user.comparePassword(currentPassword))) {
    throw new AppError('INVALID_PASSWORD', 'Cari parol yanlışdır', 400);
  }
  if (currentPassword === newPassword) {
    throw new AppError('SAME_PASSWORD', 'Yeni parol cari paroldan fərqli olmalıdır', 400);
  }
  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordResetCode = null;
  user.passwordResetExpiresAt = null;
  await user.save();
  const filter = { userId: user._id, revoked: false };
  if (keepRefreshToken) filter.tokenHash = { $ne: hashToken(keepRefreshToken) };
  await RefreshToken.updateMany(filter, { revoked: true });
  await AuditLog.create({ actorId: user._id, actorRole: user.role, action: 'PASSWORD_CHANGED' });
  return { changed: true };
}

function publicUser(user) {
  return {
    id: user._id,
    role: user.role,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    username: user.username || null,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
  };
}

module.exports = { register, requestRegisterOtp, login, loginWithOtp, refresh, logout, verifyPhone, resendVerification, requestPasswordReset, resetPassword, changePassword, publicUser, signAccess };
