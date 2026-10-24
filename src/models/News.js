const mongoose = require('mongoose');

/**
 * Sürücülər üçün "Yeniliklər" (elanlar, qayda dəyişikliyi, kampaniya, tətbiq yeniliyi).
 *  cityId = null  → bütün şəhərlərin sürücüləri görür (yalnız baş admin yarada bilər)
 *  cityId dolu    → yalnız həmin şəhərin sürücüləri (regional admin yalnız öz şəhərinə yazır)
 * Oxunmamış sayı: Driver.newsSeenAt-dən sonra dərc olunan xəbərlər.
 */
const newsSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    // info | promo | warning | update — tətbiqdə ikon/rəng seçimi üçün
    kind: { type: String, enum: ['info', 'promo', 'warning', 'update'], default: 'info' },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null, index: true },
    pinned: { type: Boolean, default: false },
    // İstəyə bağlı keçid (məs. Play Store, sayt, forma)
    linkUrl: { type: String, default: null, maxlength: 500 },
    linkLabel: { type: String, default: null, maxlength: 40 },
    publishedAt: { type: Date, default: Date.now, index: true },
    // Bu tarixdən sonra siyahıda görünmür (null → həmişə)
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

newsSchema.index({ deletedAt: 1, cityId: 1, publishedAt: -1 });

module.exports = mongoose.model('News', newsSchema);
