const mongoose = require('mongoose');

/** Sürücü ↔ ofis (admin) mesajı. Sifarişdən asılı deyil. */
const supportMessageSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null },
    sender: { type: String, enum: ['DRIVER', 'ADMIN'], required: true },
    // Admin yazıbsa: hansı admin (audit və "kim yazdı" üçün)
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminName: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 1000 },
    broadcast: { type: Boolean, default: false },
  },
  { timestamps: true }
);

supportMessageSchema.index({ driverId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
