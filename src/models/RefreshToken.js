const mongoose = require('mongoose');

module.exports = mongoose.model(
  'RefreshToken',
  new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
    revoked: { type: Boolean, default: false },
    // Sürücü sessiyasının id-si (User.activeSessionId). Başqa cihazdan giriş olunanda köhnə sessiya tanınır.
    sessionId: { type: String, default: null },
    // Rotasiya vaxtı (yenisi verilib). Qısa güzəşt müddətində köhnə token bir daha qəbul olunur:
    // cavab şəbəkədə itəndə / tətbiq yarımçıq bağlananda sürücü səbəbsiz çıxış etməsin.
    rotatedAt: { type: Date, default: null },
  }, { timestamps: true })
);
