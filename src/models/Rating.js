const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true },
  score: { type: Number, min: 1, max: 5, required: true },
  comment: String,
  feeApplied: { type: Boolean, default: false },
}, { timestamps: true });

// Sürücünün rəyləri (profil, admin, statistika): indekssiz hər sorğu bütün rəyləri tarayırdı
schema.index({ driverId: 1, createdAt: -1 });
schema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('Rating', schema);
