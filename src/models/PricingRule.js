const mongoose = require('mongoose');

module.exports = mongoose.model(
  'PricingRule',
  new mongoose.Schema({
    name: { type: String, required: true },
    active: { type: Boolean, default: true, index: true },
    version: { type: Number, default: 1 },
    // basic | city | bolt: hər nəqliyyat sinfi üçün ayrı tarif (admin paneldən dəyişir)
    vehicleType: { type: String, default: 'basic', index: true },
    baseFareMinor: { type: Number, default: 0 },
    stopFeeMinor: { type: Number, default: 0 },
    perKmMinor: { type: Number, default: 0 },
    perMinuteMinor: { type: Number, default: 0 },
    waitingFeePerMinuteMinor: { type: Number, default: 0 },
    cancellationFeeMinor: { type: Number, default: 0 },
    minFareMinor: { type: Number, default: 0 },
    maxFareMinor: { type: Number, default: null },
    surgeMultiplier: { type: Number, default: 1 },
    bands: [
      {
        fromKm: Number,
        toKm: Number,
        fareMinor: Number,
      },
    ],
  }, { timestamps: true })
);
