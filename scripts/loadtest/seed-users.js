/**
 * YÜK TESTİ ÜÇÜN test müştəriləri və tokenlər yaradır. YALNIZ STAGING bazasında işlədin!
 *
 *   MONGODB_URI=<staging> JWT_ACCESS_SECRET=<staging açarı> LOADTEST_USERS=2000 \
 *     node scripts/loadtest/seed-users.js > tokens.json
 *
 * Nəticə: tokens.json — [{ token }] (k6 skripti bunu oxuyur). Nömrələr +99400000xxxx aralığındadır,
 * real istifadəçilərlə qarışmır; `--clean` ilə silinir.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { User, Customer } = require('../../src/models');

const COUNT = Number(process.env.LOADTEST_USERS || 1000);
const PREFIX = '+99400000';

async function main() {
  if (config.env === 'production' && process.env.LOADTEST_ALLOW_PROD !== 'true') {
    throw new Error('Production bazasında işlətmək olmaz (staging istifadə edin)');
  }
  await mongoose.connect(config.mongoUri);
  if (process.argv.includes('--clean')) {
    const users = await User.find({ phone: { $regex: `^\\${PREFIX}` } }).select('_id').lean();
    await Customer.deleteMany({ userId: { $in: users.map((u) => u._id) } });
    await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
    console.error(`silindi: ${users.length}`);
    await mongoose.disconnect();
    return;
  }
  const out = [];
  for (let i = 0; i < COUNT; i += 1) {
    const phone = `${PREFIX}${String(i).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    let user = await User.findOne({ phone });
    if (!user) {
      // eslint-disable-next-line no-await-in-loop
      user = await User.create({
        phone, role: 'CUSTOMER', isActive: true, firstName: 'Load', lastName: String(i),
        username: `load${i}`, usernameLower: `load${i}`,
      });
      // eslint-disable-next-line no-await-in-loop
      await Customer.create({ userId: user._id });
    }
    out.push({ token: jwt.sign({ sub: String(user._id), role: 'CUSTOMER' }, config.jwt.accessSecret, { expiresIn: '6h' }) });
  }
  process.stdout.write(JSON.stringify(out));
  console.error(`hazır: ${out.length} istifadəçi`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
