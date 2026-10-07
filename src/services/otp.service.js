const crypto = require('crypto');
const { OtpCode } = require('../models');
const config = require('../config');
const { AppError } = require('../utils/errors');
const { sendOtpSms } = require('./sms.service');

const HOUR_MS = 3600 * 1000;

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(phone, code) {
  return crypto.createHmac('sha256', config.otp.secret).update(`${phone}:${code}`).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function cooldownError(seconds) {
  return new AppError(
    'OTP_COOLDOWN',
    `Yeni kod üçün ${seconds} saniyə gözləyin`,
    429,
    { retryAfter: seconds }
  );
}

/** Kod yaradır, saxlayır və SMS ilə göndərir. */
async function requestOtp(phone) {
  const now = new Date();
  const cooldownMs = config.otp.resendCooldownSec * 1000;
  const code = generateCode();
  const fields = {
    codeHash: hashCode(phone, code),
    expiresAt: new Date(now.getTime() + config.otp.ttlSec * 1000),
    attempts: 0,
    lastSentAt: now,
  };

  const existing = await OtpCode.findOne({ phone });
  let docId;

  if (!existing) {
    try {
      const doc = await OtpCode.create({
        phone,
        ...fields,
        sendCount: 1,
        windowStartedAt: now,
        purgeAt: new Date(now.getTime() + HOUR_MS),
      });
      docId = doc._id;
    } catch (e) {
      if (e && e.code === 11000) throw cooldownError(config.otp.resendCooldownSec);
      throw e;
    }
  } else {
    const sinceLast = now - existing.lastSentAt;
    if (sinceLast < cooldownMs) throw cooldownError(Math.ceil((cooldownMs - sinceLast) / 1000));

    const windowExpired = now - existing.windowStartedAt >= HOUR_MS;
    if (!windowExpired && existing.sendCount >= config.otp.maxSendsPerHour) {
      const waitMin = Math.ceil((existing.windowStartedAt.getTime() + HOUR_MS - now) / 60000);
      throw new AppError(
        'OTP_LIMIT',
        `Çox sayda cəhd. ${waitMin} dəqiqədən sonra yenidən cəhd edin`,
        429,
        { retryAfterMin: waitMin }
      );
    }

    const update = windowExpired
      ? {
          $set: {
            ...fields,
            sendCount: 1,
            windowStartedAt: now,
            purgeAt: new Date(now.getTime() + HOUR_MS),
          },
        }
      : { $set: fields, $inc: { sendCount: 1 } };

    // Optimistic lock: eyni anda iki sorğu gəlsə yalnız biri keçir.
    const updated = await OtpCode.findOneAndUpdate(
      { _id: existing._id, lastSentAt: existing.lastSentAt },
      update,
      { new: true }
    );
    if (!updated) throw cooldownError(config.otp.resendCooldownSec);
    docId = updated._id;
  }

  try {
    const result = await sendOtpSms(phone, code);
    // devCode yalnız SMS açarı olmayan inkişaf mühitində qaytarılır.
    return result.dev ? { devCode: code } : {};
  } catch (e) {
    // SMS getmədi: istifadəçi gözləmədən yenidən cəhd edə bilsin.
    await OtpCode.updateOne(
      { _id: docId },
      { $set: { lastSentAt: new Date(0), codeHash: null }, $inc: { sendCount: -1 } }
    );
    throw e;
  }
}

/** Kodu yoxlayır. Uğurlu olarsa kod istifadə olunmuş sayılır (təkistifadəlik). */
async function verifyOtp(phone, code) {
  const invalid = () => new AppError('INVALID_CODE', 'Kod səhvdir və ya vaxtı bitib', 400);
  const doc = await OtpCode.findOne({ phone });
  if (!doc || !doc.codeHash || doc.expiresAt < new Date()) throw invalid();

  // Cəhd sayğacı atomik artırılır: paralel sorğularla brute-force mümkün deyil.
  const counted = await OtpCode.findOneAndUpdate(
    { _id: doc._id, codeHash: doc.codeHash, attempts: { $lt: config.otp.maxAttempts } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!counted) {
    throw new AppError('OTP_LOCKED', 'Çox sayda səhv cəhd. Yeni kod istəyin', 429);
  }

  if (!safeEqualHex(hashCode(phone, String(code)), doc.codeHash)) throw invalid();

  const consumed = await OtpCode.findOneAndUpdate(
    { _id: doc._id, codeHash: doc.codeHash },
    { $set: { codeHash: null } }
  );
  if (!consumed) throw invalid();
}

module.exports = { requestOtp, verifyOtp, generateCode, hashCode };
