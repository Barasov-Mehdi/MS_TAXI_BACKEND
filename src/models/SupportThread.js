const mongoose = require('mongoose');

/** Sürücü ↔ ofis (admin) yazışmasının başlığı: hər sürücü üçün bir dənə. Siyahı və oxunmamış sayı üçündür. */
const supportThreadSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, unique: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null, index: true },
    lastMessageAt: { type: Date, default: null, index: true },
    lastText: { type: String, default: '' },
    lastSender: { type: String, enum: ['DRIVER', 'ADMIN', null], default: null },
    unreadForAdmin: { type: Number, default: 0 },
    unreadForDriver: { type: Number, default: 0 },
  },
  { timestamps: true }
);

supportThreadSchema.index({ cityId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('SupportThread', supportThreadSchema);
