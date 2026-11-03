const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true },
  clientMessageId: { type: String, required: true },
  deliveredAt: Date,
  readAt: Date,
}, { timestamps: true });

schema.index({ orderId: 1, clientMessageId: 1 }, { unique: true });
// Çat tarixçəsi: sifarişin mesajları vaxt sırası ilə (listMessages) — sıralama indeksdən oxunur
schema.index({ orderId: 1, createdAt: 1 });
// Tam silmə: istifadəçinin göndərdiyi / aldığı mesajlar
schema.index({ senderId: 1 });
schema.index({ receiverId: 1 });

module.exports = mongoose.model('Message', schema);
