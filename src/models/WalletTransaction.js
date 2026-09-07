const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
  type: {
    type: String,
    enum: ['TOP_UP', 'TRIP_COMMISSION', 'LOW_RATING_FEE', 'REFUND', 'MANUAL_ADJUSTMENT', 'CANCELLATION_FEE', 'OTHER'],
    required: true,
  },
  amountMinor: { type: Number, required: true },
  balanceBeforeMinor: { type: Number, required: true },
  balanceAfterMinor: { type: Number, required: true },
  referenceType: String,
  referenceId: mongoose.Schema.Types.ObjectId,
  idempotencyKey: { type: String, required: true },
  note: String,
  createdBy: mongoose.Schema.Types.ObjectId,
}, { timestamps: true });

schema.index({ idempotencyKey: 1 }, { unique: true });

module.exports = mongoose.model('WalletTransaction', schema);
