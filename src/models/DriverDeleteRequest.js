const mongoose = require('mongoose');

/**
 * Sürücünün silinməsi sorğusu. Regional admin sürücünü silə bilməz: sorğu göndərir,
 * baş admin təsdiqləyir (silinir) və ya rədd edir.
 */
const schema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, default: '' },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'PENDING', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '', maxlength: 500 },
    // Sorğu anındakı sürücü məlumatı (sürücü silinəndən sonra da oxunaqlı qalsın)
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
  },
  { timestamps: true }
);

// Bir sürücü üçün eyni anda yalnız bir gözləyən sorğu
schema.index({ driverId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });

module.exports = mongoose.model('DriverDeleteRequest', schema);
