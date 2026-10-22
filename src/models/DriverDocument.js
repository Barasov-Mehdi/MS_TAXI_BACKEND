const mongoose = require('mongoose');

/**
 * Sürücünün sənədi (şəkil). Fayl MongoDB GridFS-də ("driverDocs" bucket) saxlanır, burada yalnız metadata.
 * Hər növdən bir aktiv sənəd olur: yenisi yüklənəndə köhnəsi əvəz olunur (fayl silinir).
 */
const { DOC_TYPES } = require('../utils/documentTypes');

const schema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
    type: { type: String, enum: DOC_TYPES, required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    mime: { type: String, default: 'image/jpeg' },
    size: { type: Number, default: 0 },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
    rejectReason: { type: String, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

schema.index({ driverId: 1, type: 1 }, { unique: true });

const DriverDocument = mongoose.model('DriverDocument', schema);
DriverDocument.DOC_TYPES = DOC_TYPES;
module.exports = DriverDocument;
