require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../config');
const { User, PricingRule, PromoCode } = require('../models');
const { seedDefaults } = require('../services/settings.service');
const { normalizePhone } = require('../utils/validators');

async function run() {
  await mongoose.connect(config.mongoUri);
  await seedDefaults();

  // Hər nəqliyyat sinfi üçün tarif (qəpik ilə). Sonradan admin paneldən dəyişdirilə bilər.
  const baseBands = [
    { fromKm: 0, toKm: 1, fareMinor: 120 },
    { fromKm: 1, toKm: 2, fareMinor: 160 },
    { fromKm: 2, toKm: 3, fareMinor: 200 },
    { fromKm: 3, toKm: 4, fareMinor: 240 },
    { fromKm: 4, toKm: 5, fareMinor: 280 },
    { fromKm: 5, toKm: 1000, fareMinor: 320 },
  ];
  const scale = (k) => baseBands.map((b) => ({ ...b, fareMinor: Math.round(b.fareMinor * k) }));
  const plans = [
    { vehicleType: 'basic', name: 'default-basic', k: 1, minFareMinor: 120, stopFeeMinor: 50 },
    { vehicleType: 'city', name: 'default-city', k: 1.5, minFareMinor: 300, stopFeeMinor: 100 },
    { vehicleType: 'bolt', name: 'default-bolt', k: 1.2, minFareMinor: 200, stopFeeMinor: 80 },
  ];
  for (const p of plans) {
    const has = await PricingRule.findOne({
      active: true,
      ...(p.vehicleType === 'basic'
        ? { $or: [{ vehicleType: 'basic' }, { vehicleType: { $exists: false } }] }
        : { vehicleType: p.vehicleType }),
    });
    if (!has) {
      await PricingRule.create({
        name: p.name,
        vehicleType: p.vehicleType,
        active: true,
        version: 1,
        baseFareMinor: 0,
        bands: scale(p.k),
        minFareMinor: p.minFareMinor,
        stopFeeMinor: p.stopFeeMinor,
        surgeMultiplier: 1,
        cancellationFeeMinor: 0,
      });
    }
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

  // Admin: nömrə və parol mühit dəyişənlərindən gəlir. Sabit/default parol YOXDUR.
  const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '+994500000000');
  if (!adminPhone) throw new Error('ADMIN_PHONE düzgün Azərbaycan mobil nömrəsi deyil');
  let adminNote = 'admin artıq mövcuddur, dəyişdirilmədi';
  if (!(await User.findOne({ phone: adminPhone }))) {
    let password = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!password) {
      if (config.env === 'production') {
        throw new Error('Production-da ADMIN_PASSWORD təyin edilməlidir (ən azı 12 simvol)');
      }
      password = crypto.randomBytes(12).toString('base64url');
      generated = true;
    }
    if (password.length < 12) throw new Error('ADMIN_PASSWORD ən azı 12 simvol olmalıdır');
    await User.create({
      role: 'ADMIN',
      phone: adminPhone,
      passwordHash: await User.hashPassword(password),
      firstName: 'Admin',
      lastName: 'Root',
      phoneVerified: true,
    });
    adminNote = generated
      ? `admin yaradıldı: ${adminPhone} / ${password}  (parol yalnız indi göstərilir, saxlayın)`
      : `admin yaradıldı: ${adminPhone} (parol ADMIN_PASSWORD-dan)`;
  }

  console.log(`seed complete. ${adminNote}`);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
