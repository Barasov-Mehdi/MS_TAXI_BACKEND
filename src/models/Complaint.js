const mongoose = require('mongoose');

module.exports = mongoose.model(
  'Complaint',
  new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
    category: {
      type: String,
      enum: ['DRIVER_BEHAVIOR', 'VEHICLE_PROBLEM', 'PAYMENT', 'WRONG_ROUTE', 'SAFETY', 'OTHER'],
      required: true,
    },
    description: { type: String, required: true },
    attachments: [String],
    status: {
      type: String,
      enum: ['OPEN', 'IN_REVIEW', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_DRIVER', 'RESOLVED', 'REJECTED'],
      default: 'OPEN',
      index: true,
    },
    adminNotes: String,
  }, { timestamps: true })
);
