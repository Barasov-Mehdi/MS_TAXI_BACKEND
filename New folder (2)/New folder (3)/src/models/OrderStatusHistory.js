const mongoose = require('mongoose');

module.exports = mongoose.model(
  'OrderStatusHistory',
  new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    fromStatus: String,
    toStatus: { type: String, required: true },
    actorRole: String,
    actorId: mongoose.Schema.Types.ObjectId,
    reason: String,
    createdAt: { type: Date, default: Date.now },
  })
);
