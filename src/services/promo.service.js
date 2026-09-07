const { PromoCode, PromoUsage } = require('../models');
const { AppError } = require('../utils/errors');

function computeDiscount(promo, priceMinor) {
  if (promo.freeTrip && priceMinor >= (promo.freeTripMinimumAmount || 0)) {
    return priceMinor;
  }
  if (promo.discountType === 'FREE_TRIP' && priceMinor >= (promo.freeTripMinimumAmount || 0)) {
    return priceMinor;
  }
  if (promo.discountType === 'FIXED') {
    let d = promo.discountValue || 0;
    if (promo.maximumDiscount != null) d = Math.min(d, promo.maximumDiscount);
    return Math.min(d, priceMinor);
  }
  if (promo.discountType === 'PERCENTAGE') {
    let d = Math.round((priceMinor * (promo.discountValue || 0)) / 100);
    if (promo.maximumDiscount != null) d = Math.min(d, promo.maximumDiscount);
    return Math.min(d, priceMinor);
  }
  return 0;
}

async function validateAndQuote(code, customerId, priceMinor, userId) {
  if (!code) return { promo: null, discountMinor: 0 };
  const promo = await PromoCode.findOne({ code: String(code).toUpperCase() });
  if (!promo || !promo.active) throw new AppError('PROMO_INVALID', 'Promo code is invalid', 400);
  const now = new Date();
  if (promo.startDate && now < promo.startDate) throw new AppError('PROMO_NOT_STARTED', 'Promo not started', 400);
  if (promo.endDate && now > promo.endDate) throw new AppError('PROMO_EXPIRED', 'Promo expired', 400);
  if (promo.minimumOrderAmount && priceMinor < promo.minimumOrderAmount) {
    throw new AppError('PROMO_MIN_AMOUNT', 'Order amount below promo minimum', 400);
  }
  if (promo.eligibleUserIds && promo.eligibleUserIds.length && userId) {
    const ok = promo.eligibleUserIds.some((id) => String(id) === String(userId));
    if (!ok) throw new AppError('PROMO_NOT_ELIGIBLE', 'User not eligible for promo', 403);
  }
  if (promo.usageLimit != null && promo.usedCount >= promo.usageLimit) {
    throw new AppError('PROMO_LIMIT_REACHED', 'Promo usage limit reached', 400);
  }
  const userUsed = await PromoUsage.countDocuments({ promoId: promo._id, customerId });
  if (promo.perUserLimit != null && userUsed >= promo.perUserLimit) {
    throw new AppError('PROMO_USER_LIMIT', 'Promo already used by this user', 400);
  }
  return { promo, discountMinor: computeDiscount(promo, priceMinor) };
}

async function consumePromo(session, promo, customerId, orderId, discountMinor) {
  if (!promo) return null;
  const updated = await PromoCode.findOneAndUpdate(
    {
      _id: promo._id,
      $expr: {
        $or: [
          { $eq: ['$usageLimit', null] },
          { $lt: ['$usedCount', '$usageLimit'] },
        ],
      },
    },
    { $inc: { usedCount: 1 } },
    { session, new: true }
  );
  if (!updated) throw new AppError('PROMO_LIMIT_REACHED', 'Promo usage limit reached', 409);
  const usage = await PromoUsage.create(
    [{ promoId: promo._id, customerId, orderId, discountMinor }],
    { session }
  );
  return usage[0];
}

module.exports = { validateAndQuote, consumePromo, computeDiscount };
