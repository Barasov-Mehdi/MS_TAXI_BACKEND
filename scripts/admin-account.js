/**
 * Admin hesabını yoxla / parolunu yenilə.
 *
 *   ADMIN_PHONE=+99450...                       → yalnız göstərir (rol, status)
 *   ADMIN_PHONE=+99450... ADMIN_PASSWORD=...    → hesab ADMIN-dirsə parolu yeniləyir və baş admin edir
 *
 * Nömrə sürücü/sərnişin hesabıdırsa heç nə dəyişmir (həmin hesab pozulmasın).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const { User } = require('../src/models');
const { normalizePhone } = require('../src/utils/validators');

(async () => {
  const phone = normalizePhone(process.env.ADMIN_PHONE || '');
  if (!phone) throw new Error('ADMIN_PHONE düzgün deyil (məs.: +994501234567)');
  await mongoose.connect(config.mongoUri);
  const user = await User.findOne({ phone });
  if (!user) {
    console.log(`${phone}: hesab tapılmadı. "npm run seed" ilə yaradın.`);
  } else {
    console.log(`${phone}: rol=${user.role}, aktiv=${user.isActive}, ad="${[user.firstName, user.lastName].join(' ').trim()}", ` +
      `səlahiyyət=${user.role === 'ADMIN' ? (user.adminCityId ? 'regional admin' : 'baş admin') : '-'}`);
    if (user.role !== 'ADMIN') {
      console.log('Bu nömrə admin deyil. Admin üçün başqa nömrə istifadə edin (bu hesaba toxunulmadı).');
    } else if (process.env.ADMIN_PASSWORD) {
      if (process.env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD ən azı 12 simvol olmalıdır');
      user.passwordHash = await User.hashPassword(process.env.ADMIN_PASSWORD);
      user.isActive = true;
      user.adminCityId = null;
      await user.save();
      console.log('Parol yeniləndi, hesab aktivdir və baş admindir. İndi panelə daxil ola bilərsiniz.');
    }
  }
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('Xəta:', e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
