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
    passwordHash: { type: String, required: true },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    avatarUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true, index: true },
    passwordResetCode: { type: String, default: null },
    passwordResetExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
};

module.exports = mongoose.model('User', userSchema);
