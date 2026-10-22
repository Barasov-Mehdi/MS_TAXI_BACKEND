/**
 * Regional admin: yalnız öz şəhərinin sürücülərinə müdaxilə edir; baş admin hər şeyə.
 */
const CITY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CITY_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DRV_A = '111111111111111111111111';
const DRV_B = '222222222222222222222222';

let mockUser;
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = mockUser; next(); },
  requireRoles: () => (req, res, next) => next(),
}));

const drivers = {
  [DRV_A]: { _id: DRV_A, cityId: CITY_A, isOnline: false, isActive: true, isVerified: true },
  [DRV_B]: { _id: DRV_B, cityId: CITY_B, isOnline: false, isActive: true, isVerified: true },
};
const mkDriver = (d) => ({
  ...d,
  toObject() { return { ...d }; },
  save: jest.fn(async function save() { return this; }),
  populate: jest.fn(async function p() { return this; }),
});

jest.mock('../src/models', () => {
  const chain = (v) => ({ populate() { return this; }, sort() { return this; }, limit() { return Promise.resolve(v); }, lean() { return Promise.resolve(v); }, distinct: jest.fn(async () => v.map((x) => x._id)), then: (r, j) => Promise.resolve(v).then(r, j) });
  return {
    Driver: {
      findById: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      findOne: jest.fn(),
      aggregate: jest.fn(async () => []),
      __chain: chain,
    },
    Order: { find: jest.fn(), findById: jest.fn(), updateOne: jest.fn() },
    User: { find: jest.fn(), findById: jest.fn(), findOne: jest.fn() },
    AuditLog: { create: jest.fn(async () => ({})), find: jest.fn() },
    City: { find: jest.fn(), findById: jest.fn() },
    Customer: { find: jest.fn() }, Complaint: {}, OrderIssue: {}, PricingRule: {}, PromoCode: {},
    WalletTransaction: { find: jest.fn() },
    SupportThread: {}, SupportMessage: {},
  };
});
jest.mock('../src/services/settings.service', () => ({ getSettings: jest.fn(async () => ({ a: 1 })), setSetting: jest.fn() }));
jest.mock('../src/services/dispatch.service', () => ({ advanceOffersOfDriver: jest.fn(async () => {}) }));
jest.mock('../src/services/push.service', () => ({ notifyAccount: jest.fn(async () => true), notifyBalanceChange: jest.fn(async () => true), notifySupportMessage: jest.fn(async () => true) }));
jest.mock('../src/websocket/emitter', () => ({ toDriver: jest.fn(), toAdmin: jest.fn(), toAdminCity: jest.fn(), toCustomer: jest.fn() }));
jest.mock('../src/services/support.service', () => ({
  MAX_LEN: 1000,
  sendFromAdmin: jest.fn(async (admin, driver, text) => ({ _id: 'm1', sender: 'ADMIN', text, driverId: driver._id })),
  listMessages: jest.fn(async () => ({ messages: [], hasMore: false })),
  listThreads: jest.fn(async () => []),
  markReadByAdmin: jest.fn(),
  broadcast: jest.fn(async () => ({ sent: 3, total: 3 })),
}));

const express = require('express');
const request = require('supertest');
const models = require('../src/models');
const support = require('../src/services/support.service');
const { errorHandler } = require('../src/utils/errors');

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin.routes'));
app.use(errorHandler || ((err, req, res, next) => res.status(err.status || 500).json({ error: { code: err.code } })));

const regionalA = { _id: 'adm-a', role: 'ADMIN', adminCityId: CITY_A, firstName: 'Zaqatala', lastName: 'Ofis' };
const superAdmin = { _id: 'adm-s', role: 'ADMIN', adminCityId: null, firstName: 'Baş' };

beforeEach(() => {
  jest.clearAllMocks();
  models.Driver.findById.mockImplementation(async (id) => (drivers[id] ? mkDriver(drivers[id]) : null));
});

test('regional admin öz şəhərinin sürücüsünü bloklaya bilir', async () => {
  mockUser = regionalA;
  const r = await request(app).patch(`/admin/drivers/${DRV_A}`).send({ isActive: false });
  expect(r.status).toBe(200);
  expect(r.body.data.driver.isActive).toBe(false);
});

test('regional admin başqa şəhərin sürücüsünə toxuna bilmir (404 — varlığı da gizlədilir)', async () => {
  mockUser = regionalA;
  const r = await request(app).patch(`/admin/drivers/${DRV_B}`).send({ isActive: false });
  expect(r.status).toBe(404);
  const w = await request(app).post(`/admin/drivers/${DRV_B}/wallet/top-up`).send({ amountMinor: 1000 });
  expect(w.status).toBe(404);
  const m = await request(app).post(`/admin/support/${DRV_B}/messages`).send({ text: 'salam' });
  expect(m.status).toBe(404);
  expect(support.sendFromAdmin).not.toHaveBeenCalled();
});

test('regional admin sürücünün şəhərini dəyişə bilmir', async () => {
  mockUser = regionalA;
  const r = await request(app).patch(`/admin/drivers/${DRV_A}`).send({ cityId: CITY_B });
  expect(r.status).toBe(403);
});

test('baş admin istənilən sürücüyə yaza bilir', async () => {
  mockUser = superAdmin;
  const r = await request(app).post(`/admin/support/${DRV_B}/messages`).send({ text: 'Sabah ofisə gəlin' });
  expect(r.status).toBe(201);
  expect(support.sendFromAdmin).toHaveBeenCalledWith(superAdmin, expect.objectContaining({ _id: DRV_B }), 'Sabah ofisə gəlin');
});

test('regional admin öz sürücüsünə yaza bilir', async () => {
  mockUser = regionalA;
  const r = await request(app).post(`/admin/support/${DRV_A}/messages`).send({ text: 'Balansınız artırıldı' });
  expect(r.status).toBe(201);
});

test('ayarlar, tariflər, adminlər yalnız baş admin üçündür', async () => {
  mockUser = regionalA;
  for (const [m, url] of [['get', '/admin/settings'], ['patch', '/admin/settings'], ['get', '/admin/pricing-rules'], ['get', '/admin/admins'], ['post', '/admin/cities'], ['get', '/admin/customers']]) {
    const r = await request(app)[m](url).send({});
    expect([url, r.status]).toEqual([url, 403]);
  }
  mockUser = superAdmin;
  const ok = await request(app).get('/admin/settings');
  expect(ok.status).toBe(200);
});

test('regional adminin "hamıya mesaj"ı yalnız öz şəhərinə gedir', async () => {
  mockUser = regionalA;
  const r = await request(app).post('/admin/support/broadcast').send({ text: 'Sabah ofis bağlıdır', cityId: CITY_B });
  expect(r.status).toBe(200);
  const [, query] = support.broadcast.mock.calls[0];
  expect(String(query.cityId)).toBe(CITY_A); // CITY_B göndərilsə də öz şəhəri
});

test('regional admin sürücü siyahısında yalnız öz şəhərini görür', async () => {
  mockUser = regionalA;
  models.Driver.find.mockReturnValue(models.Driver.__chain([]));
  await request(app).get(`/admin/drivers?cityId=${CITY_B}`);
  const [q] = models.Driver.find.mock.calls[0];
  expect(String(q.cityId)).toBe(CITY_A);
});
