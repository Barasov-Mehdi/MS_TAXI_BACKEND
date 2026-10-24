const mongoose = require('mongoose');

/** Sərnişin ↔ ofis (admin) mesajı. Sifarişdən asılı deyil. */
const schema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null },
    sender: { type: String, enum: ['CUSTOMER', 'ADMIN'], required: true },
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminName: { type: String, default: '' },
    text: { type: String, required: true, maxlength: 1000 },
    // Optimistik göndərişdə təkrarın qarşısını almaq üçün (tətbiqin yaratdığı id)
    clientMessageId: { type: String, default: null },
  },
  { timestamps: true }
);

schema.index({ customerId: 1, createdAt: -1 });
schema.index({ customerId: 1, clientMessageId: 1 }, { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } });

module.exports = mongoose.model('CustomerSupportMessage', schema);
