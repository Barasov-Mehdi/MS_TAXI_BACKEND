const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    make: String,
    model: String,
    color: String,
    plateNumber: { type: String, required: true, unique: true },
    year: Number,
    seats: { type: Number, default: 4 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Vehicle', vehicleSchema);
