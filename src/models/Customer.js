const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
    locationUpdatedAt: { type: Date, default: null },
    defaultPaymentMethod: { type: String, enum: ['CASH', 'CARD', 'WALLET'], default: 'CASH' },
    // Müştəri tətbiqinin interfeys dili: push bildirişləri bu dildə göndərilir
    language: { type: String, enum: ['az', 'ru', 'en', 'tr'], default: 'az' },
    // FCM cihaz tokeni: tətbiq bağlı olanda sifariş bildirişləri (select:false - API cavablarına düşmür)
    fcmToken: { type: String, default: null, select: false },
    fcmTokenUpdatedAt: { type: Date, default: null },
    // Cihazdakı tətbiq versiyası: köhnə versiyalı müştərilərə "Yeni versiya" bildirişi üçün
    appVersionCode: { type: Number, default: null, index: true },
    appVersionName: { type: String, default: null },
    // Cihazın platforması (android / ios): yeniləmə bildirişi yalnız həmin platformanın versiyasına görə göndərilir
    appPlatform: { type: String, enum: ['android', 'ios', null], default: null },
    // "Yeniliklər" bölməsinə son baxış vaxtı (oxunmamış sayı bundan sonrakı elanlardır)
    newsSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

customerSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Customer', customerSchema);
