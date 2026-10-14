const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    locationUpdatedAt: { type: Date, default: null },
    defaultPaymentMethod: { type: String, enum: ['CASH', 'CARD', 'WALLET'], default: 'CASH' },
  },
  { timestamps: true }
);

customerSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Customer', customerSchema);
