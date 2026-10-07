const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['CUSTOMER', 'DRIVER', 'ADMIN'], required: true, index: true },
    phone: { type: String, required: true, unique: true, index: true },
    phoneVerified: { type: Boolean, default: false },
    phoneVerifyCode: { type: String, default: null },
    phoneVerifyExpiresAt: { type: Date, default: null },
    email: { type: String, default: null, sparse: true },
    // İstifadəçi adı sonradan əlavə olunur; sifariş üçün məcburidir.
    username: { type: String, default: undefined },
    usernameLower: { type: String, default: undefined },
    // Sərnişinlər nömrə + OTP ilə girir, parol yoxdur. Parol yalnız admin/sürücü üçündür.
    passwordHash: { type: String, default: null },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    avatarUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true, index: true },
    passwordResetCode: { type: String, default: null },
    passwordResetExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Yalnız dəyəri olan sənədlər unikal sayılır (boş username-lər toqquşmur).
userSchema.index(
  { usernameLower: 1 },
  { unique: true, partialFilterExpression: { usernameLower: { $type: 'string' } } }
);

userSchema.methods.comparePassword = function comparePassword(plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
};

module.exports = mongoose.model('User', userSchema);
