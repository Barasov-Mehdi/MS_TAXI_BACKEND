const mongoose = require('mongoose');

module.exports = mongoose.model(
  'AuditLog',
  new mongoose.Schema({
    actorId: mongoose.Schema.Types.ObjectId,
    actorRole: String,
    action: { type: String, required: true, index: true },
    entityType: String,
    entityId: mongoose.Schema.Types.ObjectId,
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
    reason: String,
    ip: String,
  }, { timestamps: true })
);
