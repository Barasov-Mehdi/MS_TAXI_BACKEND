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

module.exports = mongoose.model('Message', schema);
