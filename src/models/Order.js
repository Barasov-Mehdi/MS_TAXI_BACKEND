const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null, index: true },
    status: { type: String, required: true, index: true },
    pickup: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    destination: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    // Müştərinin göstərdiyi götürmə ünvanı (sürücü təklifində göstərilir)
    pickupAddress: { type: String, default: '' },
    pickupLabel: { type: String, default: '' },
    distanceMeters: { type: Number, required: true },
    durationMin: { type: Number, default: 0 },
    vehicleType: { type: String, default: 'basic' },
    // Aralıq və son dayanacaqlar (sonuncusu destination ilə eynidir)
    stops: [{ lat: Number, lng: Number, label: String, address: String, _id: false }],
    paymentMethod: { type: String, enum: ['CASH', 'CARD', 'WALLET'], default: 'CASH' },
    // Sifariş başqası üçün verilibsə: sürücü bu ad/nömrə ilə əlaqə saxlayır.
    passenger: {
      forOther: { type: Boolean, default: false },
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    promoCode: { type: String, default: null },
    promoUsageId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoUsage', default: null },
    pricingSnapshot: {
      pricingRuleId: mongoose.Schema.Types.ObjectId,
      pricingRuleVersion: Number,
      baseFareMinor: Number,
      distanceFareMinor: Number,
      timeFareMinor: Number,
      stopFareMinor: Number,
      vehicleType: String,
      waitingFareMinor: Number,
      discountMinor: Number,
      surgeMultiplier: Number,
      finalPriceMinor: Number,
    },
    // Ardıcıl dispatch: sifariş eyni anda yalnız BİR sürücüyə təklif olunur.
    // offeredToDriverIds - artıq təklif olunmuş (qəbul etməmiş) sürücülərin siyahısı, təkrar təklif olunmur.
    offeredToDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
    // Təklifi açıq-aşkar RƏDD edən sürücülər: bu sifarişə qaytarılmır. (Təklifi sadəcə qaçıran sürücülər
    // növbəti turda yenidən sınana bilər - məs. soket qopubsa.)
    rejectedDriverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
    currentOfferDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
    // Cari təklifin bitmə vaxtı (sürücüyə ayrılan müddətin sonu)
    offerExpiresAt: { type: Date, default: null },
    // Bu vaxta qədər heç bir sürücü qəbul etməsə, sifariş avtomatik ləğv olunur
    searchDeadlineAt: { type: Date, default: null },
    // Worker-in sifarişə növbəti dəfə nə vaxt baxacağı (təklifin bitməsi və ya sürücü tapılmadıqda təkrar cəhd)
    dispatchDueAt: { type: Date, default: null },
    // Optimistic lock: eyni anda iki proseslərin sifarişi iki dəfə növbəti sürücüyə keçirməsinin qarşısını alır
    dispatchSeq: { type: Number, default: 0 },
    acceptedAt: Date,
    startedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    cancelledBy: String,
    version: { type: Number, default: 0 },
    idempotencyKey: { type: String, default: null },
    commissionApplied: { type: Boolean, default: false },
    ratingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rating', default: null },
    // Yumşaq silmə: admin "sil" edəndə sənəd bazada qalır (sürücü statistikası/hesabatlar pozulmur)
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ pickup: '2dsphere' });
orderSchema.index({ destination: '2dsphere' });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ driverId: 1, status: 1 });
orderSchema.index({ status: 1, dispatchDueAt: 1 });
orderSchema.index({ status: 1, currentOfferDriverId: 1 });
// Eyni Idempotency-Key ilə paralel sorğular iki sifariş yarada bilməsin.
orderSchema.index(
  { customerId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Order', orderSchema);
