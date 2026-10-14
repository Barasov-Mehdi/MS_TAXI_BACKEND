const mongoose = require('mongoose');

// Hər nömrə üçün bir sənəd. Kod yalnız hash şəklində saxlanılır.
const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  codeHash: { type: String, default: null },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  // Saatlıq göndərmə limiti üçün pəncərə
  sendCount: { type: Number, default: 1 },
  windowStartedAt: { type: Date, required: true },
  // Sənəd pəncərə bitəndə avtomatik silinir (TTL)
  purgeAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = mongoose.model('OtpCode', otpSchema);
