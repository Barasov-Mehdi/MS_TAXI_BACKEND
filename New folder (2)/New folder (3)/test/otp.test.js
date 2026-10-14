// OtpCode modeli və SMS xidməti saxta (in-memory) əvəz olunur; məntiq real kodla yoxlanılır.
const mockStore = new Map();
let mockSeq = 0;

function mockMatches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$lt' in v) return doc[k] < v.$lt;
    }
    if (v instanceof Date) return doc[k] instanceof Date && doc[k].getTime() === v.getTime();
    return doc[k] === v;
  });
}
function mockApply(doc, update) {
  Object.assign(doc, update.$set || {});
  for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
}
const mockFind = (f) => [...mockStore.values()].find((d) => mockMatches(d, f)) || null;

jest.mock('../src/models', () => ({
  OtpCode: {
    findOne: async (f) => mockFind(f),
    create: async (d) => {
      if ([...mockStore.values()].some((x) => x.phone === d.phone)) throw Object.assign(new Error('dup'), { code: 11000 });
      const doc = { _id: String(++mockSeq), ...d };
      mockStore.set(doc._id, doc);
      return doc;
    },
    findOneAndUpdate: async (f, u) => {
      const d = mockFind(f);
      if (d) mockApply(d, u);
      return d;
    },
    updateOne: async (f, u) => {
      const d = mockFind(f);
      if (d) mockApply(d, u);
    },
  },
}));

let mockSent = [];
let mockFailNext = false;
jest.mock('../src/services/sms.service', () => ({
  sendOtpSms: async (phone, code) => {
    if (mockFailNext) { mockFailNext = false; throw new Error('sms down'); }
    mockSent.push({ phone, code });
    return { dev: true };
  },
}));

const otp = require('../src/services/otp.service');
const PHONE = '+994501234567';
const lastCode = () => mockSent[mockSent.length - 1].code;
const expire = () => { for (const d of mockStore.values()) d.lastSentAt = new Date(0); };

beforeEach(() => { mockStore.clear(); mockSent = []; });

test('request then verify succeeds once; code is single-use', async () => {
  await otp.requestOtp(PHONE);
  expect(lastCode()).toMatch(/^\d{6}$/);
  expect([...mockStore.values()][0].codeHash).not.toContain(lastCode()); // yalnız hash saxlanır
  await expect(otp.verifyOtp(PHONE, lastCode())).resolves.toBeUndefined();
  await expect(otp.verifyOtp(PHONE, lastCode())).rejects.toMatchObject({ code: 'INVALID_CODE' });
});

test('resend cooldown is enforced', async () => {
  await otp.requestOtp(PHONE);
  await expect(otp.requestOtp(PHONE)).rejects.toMatchObject({ code: 'OTP_COOLDOWN', status: 429 });
  expire();
  await expect(otp.requestOtp(PHONE)).resolves.toBeDefined();
  expect(mockSent).toHaveLength(2);
});

test('hourly send limit', async () => {
  for (let i = 0; i < 5; i++) { await otp.requestOtp(PHONE); expire(); }
  await expect(otp.requestOtp(PHONE)).rejects.toMatchObject({ code: 'OTP_LIMIT' });
});

test('wrong code attempts lock the code, even the correct one afterwards', async () => {
  await otp.requestOtp(PHONE);
  const good = lastCode();
  const bad = good === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await expect(otp.verifyOtp(PHONE, bad)).rejects.toMatchObject({ code: 'INVALID_CODE' });
  await expect(otp.verifyOtp(PHONE, bad)).rejects.toMatchObject({ code: 'OTP_LOCKED' });
  await expect(otp.verifyOtp(PHONE, good)).rejects.toMatchObject({ code: 'OTP_LOCKED' });
});

test('expired code is rejected', async () => {
  await otp.requestOtp(PHONE);
  [...mockStore.values()][0].expiresAt = new Date(Date.now() - 1000);
  await expect(otp.verifyOtp(PHONE, lastCode())).rejects.toMatchObject({ code: 'INVALID_CODE' });
});

test('SMS failure releases the cooldown so user can retry immediately', async () => {
  mockFailNext = true;
  await expect(otp.requestOtp(PHONE)).rejects.toThrow('sms down');
  await expect(otp.requestOtp(PHONE)).resolves.toBeDefined();
  await expect(otp.verifyOtp(PHONE, lastCode())).resolves.toBeUndefined();
});

test('verify without request fails', async () => {
  await expect(otp.verifyOtp(PHONE, '123456')).rejects.toMatchObject({ code: 'INVALID_CODE' });
});
