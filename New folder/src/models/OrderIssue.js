const mongoose = require('mongoose');

module.exports = mongoose.model(
  'OrderIssue',
  new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    reporterRole: { type: String, enum: ['CUSTOMER', 'DRIVER', 'ADMIN'], required: true },
    reporterUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: [
        'DRIVER_NOT_ARRIVED', 'CUSTOMER_NOT_FOUND', 'WRONG_PICKUP', 'WRONG_DESTINATION',
        'PAYMENT_PROBLEM', 'PRICE_PROBLEM', 'APP_PROBLEM', 'SAFETY', 'ACCIDENT', 'OTHER',
      ],
      required: true,
    },
    description: String,
    status: { type: String, enum: ['OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED'], default: 'OPEN', index: true },
    adminNotes: String,
  }, { timestamps: true })
);
