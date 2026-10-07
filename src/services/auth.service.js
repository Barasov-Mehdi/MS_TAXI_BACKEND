const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, Customer, Driver, RefreshToken } = require('../models');
const config = require('../config');
const { AppError } = require('../utils/errors');
const { AuditLog } = require('../models');
const otpService = require('./otp.service');

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

async function register({ role, phone, password, firstName, lastName, email }) {
  if (!['CUSTOMER', 'DRIVER'].includes(role)) {
    throw new AppError('INVALID_ROLE', 'Role must be CUSTOMER or DRIVER', 400);
  }
  const exists = await User.findOne({ phone });
  if (exists) throw new AppError('PHONE_TAKEN', 'Phone already registered', 409);
  const passwordHash = await User.hashPassword(password);
  const user = await User.create({
    role,
    phone,
    passwordHash,
    firstName,
    lastName,
    email,
    phoneVerifyCode: String(Math.floor(100000 + Math.random() * 900000)),
    phoneVerifyExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  if (role === 'CUSTOMER') await Customer.create({ userId: user._id });
  if (role === 'DRIVER') await Driver.create({ userId: user._id, isVerified: false });
  return user;
}

async function login({ phone, password, ip }) {
  const user = await User.findOne({ phone });
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
  if (!user.phoneVerifyCode || user.phoneVerifyCode !== code || user.phoneVerifyExpiresAt < new Date()) {
    throw new AppError('INVALID_CODE', 'Invalid or expired verification code', 400);
  }
  user.phoneVerified = true;
  user.phoneVerifyCode = null;
  await user.save();
  return user;
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

module.exports = { register, login, loginWithOtp, refresh, logout, verifyPhone, publicUser, signAccess };
