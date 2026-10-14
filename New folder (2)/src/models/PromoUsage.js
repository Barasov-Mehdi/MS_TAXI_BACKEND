const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  promoId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  discountMinor: { type: Number, required: true },
}, { timestamps: true });

schema.index({ promoId: 1, customerId: 1, orderId: 1 }, { unique: true });

module.exports = mongoose.model('PromoUsage', schema);
