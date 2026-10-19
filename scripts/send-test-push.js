/**
 * Sürücünün telefonuna test bildirişi göndərir (FCM + tətbiq yönləndirməsini yoxlamaq üçün).
 *
 *   node scripts/send-test-push.js <sürücü telefonu və ya Driver _id> <növ> [orderId]
 *
 * Növlər: chat | cancelled | queued | assigned | removed | wallet | verified | blocked
 * Nümunə: node scripts/send-test-push.js +994501234567 chat 66f0c0ffee0000000000abcd
 *
 * Lazım: .env-də MONGODB_URI və FIREBASE_SERVICE_ACCOUNT_B64; sürücü tətbiqə daxil olmuş olmalıdır (FCM tokeni serverdə saxlanıb).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const { Driver, User } = require('../src/models');
const { normalizePhone } = require('../src/utils/validators');
const push = require('../src/services/push.service');

async function main() {
  const [who, kind, orderId = '000000000000000000000000'] = process.argv.slice(2);
  if (!who || !kind) {
    console.log('İstifadə: node scripts/send-test-push.js <telefon|driverId> <chat|cancelled|queued|assigned|removed|wallet|verified|blocked> [orderId]');
    process.exit(1);
  }
  await mongoose.connect(config.mongoUri);
  let driver = null;
  if (/^[a-f0-9]{24}$/i.test(who)) driver = await Driver.findById(who);
  else {
    const user = await User.findOne({ phone: normalizePhone(who) || who, role: 'DRIVER' });
    if (user) driver = await Driver.findOne({ userId: user._id });
  }
  if (!driver) throw new Error('Sürücü tapılmadı');
  const withToken = await Driver.findById(driver._id).select('+fcmToken').lean();
  if (!withToken.fcmToken) throw new Error('Bu sürücünün FCM tokeni yoxdur: tətbiqə daxil olub bildiriş icazəsi verilməlidir');

  const id = driver._id;
  const calls = {
    chat: () => push.notifyChatMessage(id, { orderId, messageId: 'test', senderName: 'Sərnişin', text: 'Salam, mən girişdəyəm. Haradasınız?' }),
    cancelled: () => push.notifyOrderCancelled(id, orderId, 'CUSTOMER'),
    queued: () => push.notifyQueuedOrder(id, orderId),
    assigned: () => push.notifyOrderAssigned(id, orderId),
    removed: () => push.notifyOrderRemoved(id, orderId),
    wallet: () => push.notifyBalanceChange(id, { amountMinor: 1000, balanceMinor: 2350, kind: 'TOP_UP' }),
    verified: () => push.notifyAccount(id, 'verified'),
    blocked: () => push.notifyAccount(id, 'blocked'),
  };
  if (!calls[kind]) throw new Error(`Naməlum növ: ${kind}`);
  const ok = await calls[kind]();
  console.log(ok ? 'Göndərildi ✔' : 'Göndərilmədi (Firebase konfiqurasiyasını və tokeni yoxlayın)');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message || e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
