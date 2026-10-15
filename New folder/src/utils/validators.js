// Azərbaycan mobil operator prefiksləri: +994 XX XXX XX XX
const MOBILE_PREFIXES = ['10', '50', '51', '55', '60', '70', '77', '99'];

/**
 * İstənilən yazılışı (+994501234567, 994501234567, 0501234567, 501234567)
 * +994XXXXXXXXX formatına gətirir. Yanlışdırsa null qaytarır.
 */
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('994')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length !== 9 || !MOBILE_PREFIXES.includes(digits.slice(0, 2))) return null;
  return `+994${digits}`;
}

// 3–20 simvol: hərf (Azərbaycan hərfləri daxil), rəqəm, nöqtə, alt xətt.
const USERNAME_RE = /^[\p{L}0-9][\p{L}0-9_.]{2,19}$/u;

/** Düzgündürsə { username, usernameLower } qaytarır, əks halda null. */
function parseUsername(input) {
  const username = String(input || '').trim();
  if (!USERNAME_RE.test(username)) return null;
  return { username, usernameLower: username.toLowerCase() };
}

module.exports = { normalizePhone, parseUsername, MOBILE_PREFIXES };
