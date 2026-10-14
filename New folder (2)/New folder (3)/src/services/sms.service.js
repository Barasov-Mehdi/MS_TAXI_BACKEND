const crypto = require('crypto');
const config = require('../config');
const { AppError } = require('../utils/errors');

/**
 * 1sms.az OTP API: POST /api/v1/sms/otp
 * Header: X-API-Key, X-Idempotency-Key. Body: { to, text, senderName }
 */
async function sendOtpSms(phone, code) {
  const text = `MS Taxi: təsdiq kodunuz ${code}. Kodu heç kimlə paylaşmayın.`;

  if (!config.sms.apiKey) {
    if (config.env === 'production') {
      console.error('[sms] SMS_API_KEY təyin edilməyib');
      throw new AppError('SMS_NOT_CONFIGURED', 'SMS xidməti hazırda əlçatan deyil', 503);
    }
    console.log(`[sms:DEV] ${phone} -> ${code}`);
    return { dev: true };
  }

  let res;
  try {
    res = await fetch(config.sms.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.sms.apiKey,
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ to: phone, text, senderName: config.sms.senderName }),
      signal: AbortSignal.timeout(config.sms.timeoutMs),
    });
  } catch (e) {
    console.error('[sms] şəbəkə xətası:', e.message);
    throw new AppError('SMS_SEND_FAILED', 'SMS göndərilmədi, bir az sonra yenidən cəhd edin', 502);
  }

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* ignore */ }
    // 401 açar səhvi, 402 balans, 403 icazə/sender/test rejimi, 429 limit, 502 operator xətası
    console.error('[sms] 1sms.az xətası:', res.status, JSON.stringify(body));
    throw new AppError('SMS_SEND_FAILED', 'SMS göndərilmədi, bir az sonra yenidən cəhd edin', 502);
  }

  const body = await res.json().catch(() => ({}));
  return { messageId: body.messageId };
}

module.exports = { sendOtpSms };
