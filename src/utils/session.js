const crypto = require('crypto');
const { AppError } = require('./errors');

/**
 * Bir hesab = bir cihaz.
 * Sürücü hesabına yeni cihazdan daxil olunanda `User.activeSessionId` yenilənir; köhnə cihazın access tokeni,
 * refresh tokeni və soketi bu id-yə uyğun gəlmədiyi üçün dərhal etibarsız olur.
 * Söndürmək üçün: DRIVER_SINGLE_SESSION=false
 */
function singleSessionFor(user) {
  return !!user && user.role === 'DRIVER' && process.env.DRIVER_SINGLE_SESSION !== 'false';
}

const newSessionId = () => crypto.randomBytes(16).toString('hex');

/** Çıxış / parol sıfırlama: heç bir cihaza aid olmayan id (köhnə tokenlər də keçmir). */
const endedSessionId = () => `x:${newSessionId()}`;
const isEndedSession = (sid) => typeof sid === 'string' && sid.startsWith('x:');

/** Tokendəki sid aktiv sessiya ilə üst-üstə düşmür. */
function sessionMismatch(user, tokenSid) {
  return singleSessionFor(user) && !!user.activeSessionId && tokenSid !== user.activeSessionId;
}

/**
 * Uyğunsuzluğun səbəbinə görə xəta: başqa cihazdan giriş → SESSION_REPLACED (tətbiq izah göstərir),
 * çıxış / parol sıfırlama → adi UNAUTHORIZED.
 */
function sessionMismatchError(user) {
  if (isEndedSession(user && user.activeSessionId)) return new AppError('UNAUTHORIZED', 'Session ended', 401);
  return new AppError('SESSION_REPLACED', 'Hesabınıza başqa cihazdan daxil olunub', 401);
}

module.exports = { singleSessionFor, newSessionId, endedSessionId, isEndedSession, sessionMismatch, sessionMismatchError };
