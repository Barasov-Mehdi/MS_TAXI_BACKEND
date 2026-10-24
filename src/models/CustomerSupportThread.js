const mongoose = require('mongoose');

/**
 * Sərnişin ↔ ofis (admin) yazışmasının başlığı: hər sərnişin üçün bir dənə.
 * cityId: sərnişinin ilk yazdığı yerə ən yaxın şəhər (regional admin yalnız öz şəhərininkini görür).
 * Şəhər təyin olunmayıbsa (null) yalnız baş adminlər görür.
 */
const schema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null, index: true },
    lastMessageAt: { type: Date, default: null, index: true },
    lastText: { type: String, default: '' },
    lastSender: { type: String, enum: ['CUSTOMER', 'ADMIN', null], default: null },
    unreadForAdmin: { type: Number, default: 0 },
    unreadForCustomer: { type: Number, default: 0 },
  },
  { timestamps: true }
);

schema.index({ cityId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('CustomerSupportThread', schema);
