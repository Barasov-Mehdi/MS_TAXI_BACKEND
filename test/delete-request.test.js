/** Regional admin sürücünü silə bilməz: yalnız sorğu göndərir; baş admin təsdiqləyir. */
const CITY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DRV_A = '111111111111111111111111';
const REQ = '333333333333333333333333';

let mockUser;
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = mockUser; next(); },
  requireRoles: () => (req, res, next) => next(),
}));
jest.mock('../src/models', () => ({
  Driver: { findById: jest.fn() },
  DriverDeleteRequest: { create: jest.fn(), findOne: jest.fn(), updateMany: jest.fn() },
  AuditLog: { create: jest.fn(async () => ({})) },
  Order: {}, Customer: {}, User: {}, Complaint: {}, OrderIssue: {}, City: {}, Rating: {}, Vehicle: {}, TripEarning: {},
  OrderStatusHistory: {}, Message: {}, SupportThread: {}, PricingRule: {}, PromoCode: {}, WalletTransaction: {},
}));
jest.mock('../src/services/adminViews.service', () => ({
  driverInfoMap: jest.fn(async () => new Map([['111111111111111111111111', { name: 'Əli', phone: '+994501112233', cityName: 'Zaqatala' }]])),
  displayName: () => 'Zaqatala Ofis',
  oid: (v) => v,
  paging: () => ({ skip: 0, limit: 25, page: 1 }),
}));
jest.mock('../src/services/driverAdmin.service', () => ({ softDeleteDriver: jest.fn(async () => ({})) }));
jest.mock('../src/services/settings.service', () => ({ getSettings: jest.fn(), setSetting: jest.fn() }));
jest.mock('../src/services/dispatch.service', () => ({ advanceOffersOfDriver: jest.fn() }));
jest.mock('../src/services/push.service', () => ({}));
jest.mock('../src/services/support.service', () => ({ MAX_LEN: 1000 }));
jest.mock('../src/websocket/emitter', () => ({ toDriver: jest.fn(), toAdmin: jest.fn(), toAdminCity: jest.fn() }));

const express = require('express');
const request = require('supertest');
const models = require('../src/models');
const { softDeleteDriver } = require('../src/services/driverAdmin.service');
const realtime = require('../src/websocket/emitter');
const { errorHandler } = require('../src/utils/errors');

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin.routes'));
app.use(errorHandler);

const regional = { _id: 'adm-a', role: 'ADMIN', adminCityId: CITY_A, firstName: 'Zaqatala' };
const superAdmin = { _id: 'adm-s', role: 'ADMIN', adminCityId: null };

beforeEach(() => {
  jest.clearAllMocks();
  models.Driver.findById.mockResolvedValue({ _id: DRV_A, cityId: CITY_A, deletedAt: null });
});

test('regional admin sürücünü birbaşa silə bilmir', async () => {
  mockUser = regional;
  const r = await request(app).delete(`/admin/drivers/${DRV_A}`);
  expect(r.status).toBe(403);
  expect(softDeleteDriver).not.toHaveBeenCalled();
});

test('regional admin silmə sorğusu göndərir → baş adminə bildiriş', async () => {
  mockUser = regional;
  models.DriverDeleteRequest.create.mockImplementation(async (d) => ({ _id: REQ, ...d }));
  const r = await request(app).post(`/admin/drivers/${DRV_A}/delete-request`).send({ reason: 'Sənədləri saxtadır' });
  expect(r.status).toBe(201);
  expect(models.DriverDeleteRequest.create).toHaveBeenCalledWith(expect.objectContaining({ driverId: DRV_A, reason: 'Sənədləri saxtadır', driverName: 'Əli' }));
  expect(realtime.toAdmin).toHaveBeenCalledWith('delete_request', expect.anything());
});

test('eyni sürücü üçün ikinci gözləyən sorğu olmur', async () => {
  mockUser = regional;
  models.DriverDeleteRequest.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
  const r = await request(app).post(`/admin/drivers/${DRV_A}/delete-request`).send({ reason: 'təkrar' });
  expect(r.status).toBe(409);
});

test('regional admin sorğunu təsdiqləyə bilmir, baş admin təsdiqləyir → sürücü silinir', async () => {
  mockUser = regional;
  expect((await request(app).post(`/admin/delete-requests/${REQ}/approve`).send({})).status).toBe(403);

  mockUser = superAdmin;
  const doc = { _id: REQ, driverId: DRV_A, cityId: CITY_A, status: 'PENDING', reason: 'x', save: jest.fn() };
  models.DriverDeleteRequest.findOne.mockResolvedValue(doc);
  const r = await request(app).post(`/admin/delete-requests/${REQ}/approve`).send({ note: 'ok' });
  expect(r.status).toBe(200);
  expect(softDeleteDriver).toHaveBeenCalledWith(DRV_A, superAdmin);
  expect(doc.status).toBe('APPROVED');
});

test('regional admin balansı yalnız artıra bilər, düzəliş (çıxma) baş admindədir', async () => {
  mockUser = regional;
  const r = await request(app).post(`/admin/drivers/${DRV_A}/wallet/adjustment`).send({ amountMinor: -500 });
  expect(r.status).toBe(403);
});
