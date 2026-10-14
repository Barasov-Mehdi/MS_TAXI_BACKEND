const mongoose = require('mongoose');

module.exports = mongoose.model(
  'PromoCode',
  new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true },
    discountType: { type: String, enum: ['FIXED', 'PERCENTAGE', 'FREE_TRIP'], required: true },
    discountValue: { type: Number, default: 0 },
    minimumOrderAmount: { type: Number, default: 0 },
    maximumDiscount: { type: Number, default: null },
    freeTrip: { type: Boolean, default: false },
    freeTripMinimumAmount: { type: Number, default: 0 },
    usageLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 },
    startDate: Date,
    endDate: Date,
    active: { type: Boolean, default: true },
    eligibleUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  }, { timestamps: true })
);
