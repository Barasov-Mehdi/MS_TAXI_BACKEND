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
    // Serverin "sürücü canlıdır" vaxtı (hər mesaj/heartbeat yeniləyir) - offline süpürgəsi bunu istifadə edir.
    locationUpdatedAt: { type: Date, default: null },
    // Koordinatın GPS tərəfindən həqiqətən ölçüldüyü vaxt (server saatı ilə). Sifariş uyğunlaşdırması bunu yoxlayır:
    // heartbeat köhnə koordinatı "təzə" göstərməsin.
    locationFixAt: { type: Date, default: null },
    currentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    queuedOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    walletBalanceMinor: { type: Number, default: 0 },
    // Dispatch: sürücü eyni anda yalnız bir sifariş təklifi ala bilər (atomik kilid, özü bitir).
    offerOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    offerLockUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

driverSchema.index({ location: '2dsphere' });
driverSchema.index({ isOnline: 1, isActive: 1, isVerified: 1 });
driverSchema.index({ isOnline: 1, locationUpdatedAt: 1 });
driverSchema.index({ isOnline: 1, locationFixAt: 1 });

module.exports = mongoose.model('Driver', driverSchema);
