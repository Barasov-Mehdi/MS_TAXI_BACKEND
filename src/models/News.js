const mongoose = require('mongoose');

/**
 * "Yeniliklər" (elanlar, qayda dəyişikliyi, kampaniya, tətbiq yeniliyi).
 *  audience = drivers   → yalnız sürücü tətbiqi (köhnə qeydlərdə sahə yoxdur → sürücü sayılır)
 *  audience = customers → yalnız müştəri tətbiqi
 *  audience = all       → hər iki tətbiq
 *  cityId = null  → bütün şəhərlərin sürücüləri görür (yalnız baş admin yarada bilər)
 *  cityId dolu    → yalnız həmin şəhərin sürücüləri (regional admin yalnız öz şəhərinə və yalnız sürücülərə yazır)
 *  Müştərilər şəhərə bağlı deyil: müştəri elanı (customers / all) həmişə ümumidir (cityId = null).
 * Oxunmamış sayı: Driver.newsSeenAt / Customer.newsSeenAt-dən sonra dərc olunan xəbərlər.
 */
const newsSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    // info | promo | warning | update — tətbiqdə ikon/rəng seçimi üçün
    kind: { type: String, enum: ['info', 'promo', 'warning', 'update'], default: 'info' },
    audience: { type: String, enum: ['drivers', 'customers', 'all'], default: 'drivers', index: true },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null, index: true },
    pinned: { type: Boolean, default: false },
    // İstəyə bağlı keçid (məs. Play Store, sayt, forma)
    linkUrl: { type: String, default: null, maxlength: 500 },
    linkLabel: { type: String, default: null, maxlength: 40 },
    // Şəkil (GridFS: newsImages). imageUrl mütləq ünvandır (tətbiq + push bildirişi üçün)
    imageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    imageUrl: { type: String, default: null, maxlength: 500 },
    publishedAt: { type: Date, default: Date.now, index: true },
    // Bu tarixdən sonra siyahıda görünmür (null → həmişə)
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Sürücülərə elan (socket + push) göndərildiyi vaxt. null + publishedAt keçib → planlaşdırıcı göndərəcək
    announcedAt: { type: Date, default: null, index: true },
    // true → elan olunanda push göndərilmir (yalnız siyahıda + tətbiq açıqdırsa banner)
    silent: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

newsSchema.index({ deletedAt: 1, cityId: 1, publishedAt: -1 });

module.exports = mongoose.model('News', newsSchema);
