const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null, index: true },
    status: { type: String, required: true, index: true },
    pickup: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    destination: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    distanceMeters: { type: Number, required: true },
    paymentMethod: { type: String, enum: ['CASH', 'CARD', 'WALLET'], default: 'CASH' },
    promoCode: { type: String, default: null },
    promoUsageId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoUsage', default: null },
    pricingSnapshot: {
      pricingRuleId: mongoose.Schema.Types.ObjectId,
      pricingRuleVersion: Number,
      baseFareMinor: Number,
      distanceFareMinor: Number,
      timeFareMinor: Number,
      waitingFareMinor: Number,
      discountMinor: Number,
      surgeMultiplier: Number,
      finalPriceMinor: Number,
    },
    offeredToDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
    acceptedAt: Date,
    startedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    cancelledBy: String,
    version: { type: Number, default: 0 },
    idempotencyKey: { type: String, default: null, index: true },
    commissionApplied: { type: Boolean, default: false },
    ratingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rating', default: null },
  },
  { timestamps: true }
);

orderSchema.index({ pickup: '2dsphere' });
orderSchema.index({ destination: '2dsphere' });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ driverId: 1, status: 1 });

module.exports = mongoose.model('Order', orderSchema);
