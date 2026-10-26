const mongoose = require('mongoose');

const pointSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    label: { type: String, default: '' },
    address: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * Planlı (avtomatik) sifariş: müştəri marşrutu, sinfi və vaxtı seçir — vaxt çatanda server sifarişi ÖZÜ yaradır
 * (tətbiq bağlı olsa da). Birdəfəlik (repeat=once, date) və ya həftəlik (repeat=weekly, days) ola bilər.
 * Vaxt Azərbaycan saatı ilə saxlanılır (date/time), icra anı isə UTC olaraq nextRunAt-dadır.
 */
const scheduledRideSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: '', maxlength: 40 },
    pickup: { type: pointSchema, required: true },
    stops: { type: [pointSchema], validate: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 4 },
    vehicleType: { type: String, default: 'basic' },
    paymentMethod: { type: String, enum: ['CASH'], default: 'CASH' },
    repeat: { type: String, enum: ['once', 'weekly'], required: true },
    // repeat=once: yerli tarix "YYYY-MM-DD"
    date: { type: String, default: null },
    // repeat=weekly: ISO həftə günləri (1 = bazar ertəsi ... 7 = bazar)
    days: { type: [Number], default: [] },
    // Yerli saat "HH:mm"
    time: { type: String, required: true },
    active: { type: Boolean, default: true, index: true },
    nextRunAt: { type: Date, default: null, index: true },
    // nextRunAt üçün xatırlatma göndərilibsə həmin vaxt (təkrar göndərilməsin)
    remindedFor: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    // CREATED | SKIPPED_ACTIVE | MISSED | FAILED
    lastStatus: { type: String, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

scheduledRideSchema.index({ active: 1, nextRunAt: 1 });

module.exports = mongoose.model('ScheduledRide', scheduledRideSchema);
