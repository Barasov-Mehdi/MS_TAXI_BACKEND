/**
 * Yüksək yük düzəlişləri: kütləvi FCM göndərişi, lider kilidi (tək instansiya), yaxın sürücü keşi, artımlı reytinq.
 */
const mockSendEach = jest.fn();
const mockBulkWrite = jest.fn(async () => ({}));

jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(() => ({ name: 'x' })),
  credential: { cert: jest.fn(() => ({})) },
  messaging: jest.fn(() => ({ sendEach: mockSendEach, send: jest.fn() })),
}));

jest.mock('../src/models', () => ({
  Customer: { bulkWrite: (...a) => mockBulkWrite(...a), find: jest.fn() },
  Driver: { find: jest.fn(() => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) })) },
  Order: {},
}));
jest.mock('../src/services/settings.service', () => ({ getSettings: jest.fn(async () => ({ maxDriverRadius: 5000 })) }));

beforeAll(() => {
  process.env.FIREBASE_CUSTOMER_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'cust', client_email: 'a@b', private_key: 'k' });
});

describe('kütləvi push (sendBulkToCustomers)', () => {
  test('500-lük paketlərlə göndərir, ölü tokenləri toplu silir', async () => {
    const push = require('../src/services/push.service');
    mockSendEach.mockImplementation(async (msgs) => ({
      responses: msgs.map((m, i) => (i === 0 ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })),
    }));
    const items = Array.from({ length: 1203 }, (_, i) => ({ customerId: `c${i}`, token: `t${i}`, title: 'Salam', body: 'x', type: 'news' }));
    const r = await push.sendBulkToCustomers(items);
    expect(mockSendEach).toHaveBeenCalledTimes(3); // 500 + 500 + 203
    expect(mockSendEach.mock.calls[0][0]).toHaveLength(500);
    expect(r).toEqual({ sent: 1200, failed: 3, removed: 3 });
    const ops = mockBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(3);
    expect(ops[0].updateOne.filter).toEqual({ _id: 'c0', fcmToken: 't0' });
  });
});

describe('lider kilidi', () => {
  test('Redis yoxdursa (tək instansiya) həmişə liderdir və DB-yə sorğu getmir', () => {
    delete process.env.REDIS_URL;
    const { campaign } = require('../src/utils/leaderLock');
    expect(campaign('x')()).toBe(true);
  });
});

describe('yaxın sürücülər keşi', () => {
  test('eyni xanadan qısa müddətdə gələn sorğular bir DB sorğusunu paylaşır', async () => {
    const models = require('../src/models');
    const { findNearbyDrivers } = require('../src/services/location.service');
    await Promise.all([
      findNearbyDrivers({ latitude: 41.6336, longitude: 46.6431 }),
      findNearbyDrivers({ latitude: 41.6337, longitude: 46.6432 }),
      findNearbyDrivers({ latitude: 41.6336, longitude: 46.6431 }),
    ]);
    expect(models.Driver.find).toHaveBeenCalledTimes(1);
    await findNearbyDrivers({ latitude: 41.70, longitude: 46.70 });
    expect(models.Driver.find).toHaveBeenCalledTimes(2);
  });
});
