const mongoose = require('mongoose');

/**
 * Şəhər / bölgə. Hər şəhərin öz ofisi və öz adminləri var.
 * Sürücü qeydiyyatda şəhərini seçir; regional admin yalnız öz şəhərinin sürücülərini görür və idarə edir.
 */
const citySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameLower: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100 },
    // Sürücünün tətbiqində "Ofislə əlaqə" bölməsində göstərilir (balans artırmaq, sənədlər və s.)
    officeAddress: { type: String, default: '', maxlength: 300 },
    officePhone: { type: String, default: '', maxlength: 30 },
    workHours: { type: String, default: '', maxlength: 120 },
  },
  { timestamps: true }
);

citySchema.pre('validate', function setLower(next) {
  if (this.name) this.nameLower = String(this.name).trim().toLocaleLowerCase('az');
  next();
});

module.exports = mongoose.model('City', citySchema);
