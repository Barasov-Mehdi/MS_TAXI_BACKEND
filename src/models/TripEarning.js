const mongoose = require('mongoose');

/**
 * Sürücünün hər tamamlanan səfəri üzrə qazanc qeydi (dəyişməz jurnal).
 *
 * Niyə ayrıca kolleksiya: sürücü statistikası (gündəlik qazanc, sifariş sayı, tutulan komissiya)
 * əvvəl birbaşa `orders` kolleksiyasından hesablanırdı. Sifariş bazadan əl ilə silinəndə həmin günün
 * qazancı və sayı da itirdi. İndi səfər bitəndə bütün lazımi rəqəmlər bura köçürülür və statistika
 * yalnız buradan oxunur: sifariş silinsə də sürücünün qazanc tarixçəsi qalır.
 */
const schema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    // Sifariş silinə bilər: burada yalnız istinad kimi saxlanılır
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    completedAt: { type: Date, required: true },
    grossMinor: { type: Number, required: true }, // sərnişindən alınan məbləğ
    commissionMinor: { type: Number, default: 0 }, // balansdan tutulan komissiya
    netMinor: { type: Number, required: true }, // gross - commission
    commissionRate: { type: Number, default: null }, // faiz (məs. 10) və ya FIXED üçün null
    ratingAtTrip: { type: Number, default: null },
    distanceMeters: { type: Number, default: 0 },
    durationMin: { type: Number, default: 0 },
    paymentMethod: { type: String, default: 'CASH' },
    pickupAddress: { type: String, default: '' },
    destinationAddress: { type: String, default: '' },
    // true: sifariş artıq silinmişdi, qeyd komissiya əməliyyatından bərpa olunub (gross təxminidir)
    reconstructed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

schema.index({ orderId: 1 }, { unique: true });
schema.index({ driverId: 1, completedAt: -1 });

module.exports = mongoose.model('TripEarning', schema);
