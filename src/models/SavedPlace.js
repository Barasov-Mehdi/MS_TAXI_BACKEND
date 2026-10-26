const mongoose = require('mongoose');

/**
 * Müştərinin yadda saxladığı ünvanlar: Ev, İş və istənilən adlı ünvan ("İdman zalı", "Anamgil" ...).
 * Ev və İş hər müştəri üçün bir dənədir (service səviyyəsində qorunur).
 */
const savedPlaceSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    kind: { type: String, enum: ['home', 'work', 'other'], default: 'other' },
    // Müştərinin verdiyi ad (other üçün məcburi; home/work üçün boş ola bilər)
    name: { type: String, default: '', maxlength: 40 },
    label: { type: String, default: '', maxlength: 200 },
    address: { type: String, default: '', maxlength: 300 },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    // Qeyd: istifadə sayı — axtarışda tez-tez istifadə olunan ünvan yuxarı çıxır
    useCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

savedPlaceSchema.index({ customerId: 1, kind: 1 });

module.exports = mongoose.model('SavedPlace', savedPlaceSchema);
