const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    fromStatus: String,
    toStatus: { type: String, required: true },
    actorRole: String,
    actorId: mongoose.Schema.Types.ObjectId,
    reason: String,
    createdAt: { type: Date, default: Date.now },
});

// Sürücü profili statistikası (qəbul / ləğv faizi) üçün: aktyora görə son qeydlər
schema.index({ actorId: 1, createdAt: -1 });

module.exports = mongoose.model('OrderStatusHistory', schema);
