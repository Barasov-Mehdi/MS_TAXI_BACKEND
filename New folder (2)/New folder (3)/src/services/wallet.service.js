const { Driver, WalletTransaction } = require('../models');
const { getSettings } = require('./settings.service');
const { AppError } = require('../utils/errors');
const { percentOf } = require('../utils/money');

async function applyTransaction({
  driverId, type, amountMinor, referenceType, referenceId,
  idempotencyKey, note, createdBy, session,
}) {
  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session || null);
  if (existing) return existing;

  const driver = await Driver.findById(driverId).session(session || null);
  if (!driver) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);

  const settings = await getSettings();
  const before = driver.walletBalanceMinor || 0;
  const after = before + amountMinor;

  if (after < 0 && !settings.negativeBalanceAllowed) {
    throw new AppError('INSUFFICIENT_BALANCE', 'Driver wallet balance insufficient', 400);
  }

  driver.walletBalanceMinor = after;
  await driver.save({ session });

  try {
    const [tx] = await WalletTransaction.create(
      [{ driverId, type, amountMinor, balanceBeforeMinor: before, balanceAfterMinor: after,
         referenceType, referenceId, idempotencyKey, note, createdBy }],
      { session }
    );
    return tx;
  } catch (e) {
    if (e.code === 11000) return WalletTransaction.findOne({ idempotencyKey }).session(session || null);
    throw e;
  }
}

/**
 * Called when a trip is completed.
 * Uses driver.ratingAvg before this trip is rated.
 * 13% standard or 15% if ratingAvg < threshold. Rates replace each other.
 */
async function applyTripCommission(driverId, order, session) {
  const settings = await getSettings();
  const driver = await Driver.findById(driverId).session(session || null);
  if (!driver) throw new AppError('DRIVER_NOT_FOUND', 'Driver not found', 404);

  const ratingAvg = driver.ratingAvg ?? 5;
  const isLowRated = ratingAvg < (settings.ratingThreshold ?? 3);
  const rate = isLowRated
    ? Number(settings.lowRatingCommission ?? 15)
    : Number(settings.tripCommission ?? 13);

  const fare = order.pricingSnapshot.finalPriceMinor;
  const commissionMinor = settings.tripCommissionType === 'FIXED'
    ? Math.round(rate)
    : percentOf(fare, rate);

  if (commissionMinor <= 0) return null;

  return applyTransaction({
    driverId,
    type: 'TRIP_COMMISSION',
    amountMinor: -commissionMinor,
    referenceType: 'ORDER',
    referenceId: order._id,
    idempotencyKey: `commission:${order._id}`,
    note: isLowRated
      ? `Düşük puan komisyonu: %${rate} (o anki puan: ${ratingAvg.toFixed(2)})`
      : `Standart komisyon: %${rate}`,
    session,
  });
}

module.exports = { applyTransaction, applyTripCommission };
