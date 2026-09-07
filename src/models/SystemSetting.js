const mongoose = require('mongoose');

module.exports = mongoose.model(
  'SystemSetting',
  new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  }, { timestamps: true })
);
