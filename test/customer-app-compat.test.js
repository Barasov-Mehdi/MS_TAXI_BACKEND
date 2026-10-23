/**
 * Müştəri tətbiqi ilə uyğunluq düzəlişləri:
 *  - push mətnləri müştərinin dilində (Customer.language)
 *  - bloklanmış sərnişin REST-də 403 USER_DISABLED alır (sürücü üçün davranış dəyişməyib)
 */
const lean = (v) => ({ select: () => ({ lean: async () => v }) });
const mockOrder = { _id: 'o1', customerId: 'c1', driverId: 'd1', status: 'DRIVER_ASSIGNED', pricingSnapshot: { finalPriceMinor: 450 } };
let mockLanguage = 'ru';
const mockUsers = {};

jest.mock('../src/models', () => ({
  Order: { findById: jest.fn(() => lean(mockOrder)) },
  Driver: { findById: jest.fn(() => lean({ userId: 'u9', vehicleId: 'v1' })), findOne: jest.fn(async () => ({ _id: 'd1' })) },
  User: {
    findById: jest.fn((id) => {
      const u = mockUsers[id];
      // authenticate: await User.findById(id) ; customerNotify: User.findById().select().lean()
      const p = Promise.resolve(u || { firstName: 'Əli' });
      p.select = () => ({ lean: async () => ({ firstName: 'Əli' }) });
      return p;
    }),
  },
  Vehicle: { findById: jest.fn(() => lean({ make: 'Toyota', model: 'Prius', color: 'Ağ', plateNumber: '10-AB-123' })) },
  Customer: {
    findById: jest.fn(() => lean({ language: mockLanguage })),
    findOne: jest.fn(async () => ({ _id: 'c1' })),
  },
}));
const mockSends = [];
jest.mock('../src/services/push.service', () => ({ sendToCustomer: jest.fn(async (id, n) => { mockSends.push({ id, ...n }); return true; }) }));

const jwt = require('jsonwebtoken');
const config = require('../src/config');
const notify = require('../src/services/customerNotify');
const { authenticate } = require('../src/middleware/auth');

const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  mockSends.length = 0;
  notify._reset();
});

test('push text follows customer language (ru)', async () => {
  mockLanguage = 'ru';
  notify.onCustomerEvent('c1', 'order_status_changed', { orderId: 'o1', status: 'DRIVER_ASSIGNED' });
  await flush();
  expect(mockSends).toHaveLength(1);
  expect(mockSends[0].title).toBe('Водитель найден');
  expect(mockSends[0].body).toContain('10-AB-123');
});

test('unknown / missing language falls back to Azerbaijani', async () => {
  mockLanguage = 'xx';
  notify.onCustomerEvent('c1', 'trip_completed', { orderId: 'o1' });
  await flush();
  expect(mockSends[0].title).toBe('Səfər tamamlandı');
  expect(mockSends[0].body).toContain('4.50 ₼');
});

test('all languages define every notification key', () => {
  const keys = Object.keys(notify.TEXTS.az);
  for (const lang of ['ru', 'en', 'tr']) {
    expect(Object.keys(notify.TEXTS[lang]).sort()).toEqual(keys.sort());
  }
});

function run(user) {
  mockUsers.u1 = user;
  const token = jwt.sign({ sub: 'u1' }, config.jwt.accessSecret);
  return new Promise((resolve) => {
    authenticate({ headers: { authorization: `Bearer ${token}` } }, {}, (err) => resolve(err));
  });
}

test('blocked customer gets 403 USER_DISABLED', async () => {
  const err = await run({ _id: 'u1', role: 'CUSTOMER', isActive: false });
  expect(err).toMatchObject({ code: 'USER_DISABLED', status: 403 });
});

test('blocked driver still gets 401 UNAUTHORIZED (unchanged)', async () => {
  const err = await run({ _id: 'u1', role: 'DRIVER', isActive: false });
  expect(err).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('active customer passes', async () => {
  const err = await run({ _id: 'u1', role: 'CUSTOMER', isActive: true });
  expect(err).toBeUndefined();
});
