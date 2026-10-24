/** İki Firebase layihəsi: sürücü və sərnişin açarları ayrı + layihə köçürmə dövründə ehtiyat göndəriş. */
const mockSends = { 'push_barasdrivers-f3fba': jest.fn(), 'push_baras-11bbd': jest.fn() };
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn((opts, name) => ({ name })),
  credential: { cert: jest.fn(() => ({})) },
  messaging: jest.fn((app) => ({ send: (...a) => mockSends[app.name](...a) })),
}));
jest.mock('../src/models', () => ({
  Driver: { findById: () => ({ select: () => ({ lean: async () => ({ _id: 'd1', fcmToken: 'tok-d' }) }) }), updateOne: jest.fn(() => ({ catch: () => {} })) },
  Customer: { findById: () => ({ select: () => ({ lean: async () => ({ _id: 'c1', fcmToken: 'tok-c' }) }) }), updateOne: jest.fn(() => ({ catch: () => {} })) },
}));
const key = (project) => JSON.stringify({ project_id: project, client_email: 'a@b.c', private_key: 'k' });
process.env.FIREBASE_DRIVER_SERVICE_ACCOUNT = key('barasdrivers-f3fba');
process.env.FIREBASE_SERVICE_ACCOUNT = key('baras-11bbd');
const push = require('../src/services/push.service');

beforeEach(() => Object.values(mockSends).forEach((f) => f.mockReset()));

test('sürücü öz layihəsinin açarı ilə, sərnişin ümumi açarla göndərilir', async () => {
  mockSends['push_barasdrivers-f3fba'].mockResolvedValue('ok');
  mockSends['push_baras-11bbd'].mockResolvedValue('ok');
  expect(await push.notifyQueuedOrder('d1', 'o1')).toBe(true);
  expect(await push.sendToCustomer('c1', { title: 'T', body: 'B', type: 'x' })).toBe(true);
  expect(mockSends['push_barasdrivers-f3fba']).toHaveBeenCalledTimes(1);
  expect(mockSends['push_baras-11bbd']).toHaveBeenCalledTimes(1);
  const st = push.getStatus();
  expect(st.driver.projectId).toBe('barasdrivers-f3fba');
  expect(st.customer.projectId).toBe('baras-11bbd');
});

test('sərnişin tətbiqi yeni layihəyə köçəndə: köhnə açar rədd edir → sürücü layihəsinin açarı ilə çatır', async () => {
  mockSends['push_baras-11bbd'].mockRejectedValue({ code: 'messaging/mismatched-credential' });
  mockSends['push_barasdrivers-f3fba'].mockResolvedValue('ok');
  expect(await push.sendToCustomer('c1', { title: 'T', body: 'B', type: 'x' })).toBe(true);
  expect(mockSends['push_barasdrivers-f3fba']).toHaveBeenCalledTimes(1);
});

test('sərnişin testi: token yoxdursa problemin tətbiqdə olduğu deyilir', async () => {
  const models = require('../src/models');
  models.Customer.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'c1', fcmToken: null }) }) });
  const r = await push.testCustomer('c1');
  expect(r).toMatchObject({ firebase: true, hasToken: false, sent: false });
  expect(r.hint).toMatch(/sərnişin tətbiqində/i);
});

test('sərnişin testi: köhnə açar rədd edir, sürücü layihəsinin açarı ilə çatır', async () => {
  const models = require('../src/models');
  models.Customer.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'c1', fcmToken: 'tok-c' }) }) });
  mockSends['push_baras-11bbd'].mockRejectedValue({ code: 'messaging/mismatched-credential' });
  mockSends['push_barasdrivers-f3fba'].mockResolvedValue('ok');
  const r = await push.testCustomer('c1');
  expect(r).toMatchObject({ sent: true, viaProjectId: 'barasdrivers-f3fba' });
});
