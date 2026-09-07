require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const { User, PricingRule, PromoCode } = require('../models');
const { seedDefaults } = require('../services/settings.service');

async function run() {
  await mongoose.connect(config.mongoUri);
  await seedDefaults();

  const exists = await PricingRule.findOne({ active: true });
  if (!exists) {
    await PricingRule.create({
      name: 'default-baku',
      active: true,
      version: 1,
      baseFareMinor: 0,
      bands: [
        { fromKm: 0, toKm: 1, fareMinor: 120 },
        { fromKm: 1, toKm: 2, fareMinor: 160 },
        { fromKm: 2, toKm: 3, fareMinor: 200 },
        { fromKm: 3, toKm: 4, fareMinor: 240 },
        { fromKm: 4, toKm: 5, fareMinor: 280 },
        { fromKm: 5, toKm: 1000, fareMinor: 320 },
      ],
      minFareMinor: 120,
      surgeMultiplier: 1,
      cancellationFeeMinor: 0,
    });
  }

  if (!(await PromoCode.findOne({ code: 'FREE3' }))) {
    await PromoCode.create({
      code: 'FREE3',
      discountType: 'FREE_TRIP',
      freeTrip: true,
      freeTripMinimumAmount: 300,
      usageLimit: 1000,
      perUserLimit: 1,
      active: true,
    });
  }

  if (!(await User.findOne({ phone: '+994500000000' }))) {
    const passwordHash = await User.hashPassword('Admin123!');
    await User.create({
      role: 'ADMIN',
      phone: '+994500000000',
      passwordHash,
      firstName: 'Admin',
      lastName: 'Root',
      phoneVerified: true,
    });
  }

  console.log('seed complete. admin phone +994500000000 / Admin123!');
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
