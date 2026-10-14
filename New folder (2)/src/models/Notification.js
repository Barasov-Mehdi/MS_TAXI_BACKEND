const mongoose = require('mongoose');

module.exports = mongoose.model(
  'Notification',
  new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: String,
    body: String,
    type: String,
    data: mongoose.Schema.Types.Mixed,
    readAt: Date,
  }, { timestamps: true })
);
