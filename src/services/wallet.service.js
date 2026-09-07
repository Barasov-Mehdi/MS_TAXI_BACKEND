const { Driver, WalletTransaction } = require('../models');
const { getSettings } = require('./settings.service');
const { AppError } = require('../utils/errors');
const { percentOf } = require('../utils/money');

async function applyTransaction({
  driverId,
  type,
  amountMinor,
  referenceType,
  referenceId,
  idempotencyKey,
  note,
  createdBy,
  session,
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
      [{
        driverId,
        type,
        amountMinor,
        balanceBeforeMinor: before,
        balanceAfterMinor: after,
        referenceType,
        referenceId,
        idempotencyKey,
        note,
        createdBy,
      }],
      { session }
    );
    return tx;
  } catch (e) {
    if (e.code === 11000) {
      return WalletTransaction.findOne({ idempotencyKey }).session(session || null);
    }
    throw e;
  }
}

async function applyTripCommission(driverId, order, session) {
  const settings = await getSettings();
  let amount = 0;
  if (settings.tripCommissionType === 'PERCENTAGE') {
    amount = -percentOf(order.pricingSnapshot.finalPriceMinor, settings.tripCommission);
  } else {
    amount = -Number(settings.tripCommission || 0);
  }
  if (amount === 0) return null;
  return applyTransaction({
    driverId,
    type: 'TRIP_COMMISSION',
    amountMinor: amount,
    referenceType: 'ORDER',
    referenceId: order._id,
    idempotencyKey: `commission:${order._id}`,
    note: 'Trip commission',
    session,
  });
}

async function applyLowRatingFee(driverId, ratingId, session) {
  const settings = await getSettings();
  const amount = -Number(settings.lowRatingFee || 0);
  if (!amount) return null;
  return applyTransaction({
    driverId,
    type: 'LOW_RATING_FEE',
    amountMinor: amount,
    referenceType: 'RATING',
    referenceId: ratingId,
    idempotencyKey: `low-rating:${ratingId}`,
    note: 'Low rating fee',
    session,
  });
}

module.exports = { applyTransaction, applyTripCommission, applyLowRatingFee };
