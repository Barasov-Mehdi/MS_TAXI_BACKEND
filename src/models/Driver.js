const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    isOnline: { type: Boolean, default: false, index: true },
    isVerified: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
    radiusMeters: { type: Number, default: 2000 },
    priority: { type: Number, default: 0 },
    ratingAvg: { type: Number, default: 5 },
    ratingCount: { type: Number, default: 0 },
    onlineSince: { type: Date, default: null },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    locationMeta: {
      accuracy: { type: Number, default: null },
      heading: { type: Number, default: null },
      speed: { type: Number, default: null },
      timestamp: { type: Date, default: null },
    },
    locationUpdatedAt: { type: Date, default: null },
    currentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    queuedOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    walletBalanceMinor: { type: Number, default: 0 },
  },
  { timestamps: true }
);

driverSchema.index({ location: '2dsphere' });
driverSchema.index({ isOnline: 1, isActive: 1, isVerified: 1 });

module.exports = mongoose.model('Driver', driverSchema);
