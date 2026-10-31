/**
 * Saytdan hesab silmə (girişsiz, Google Play tələbi):
 *  - request: hesab varsa SMS kod göndərilir; yoxdursa da cavab eynidir (nömrə sızmır)
 *  - confirm: kod yoxlanılır ('delete' məqsədi), hesab silinir; səhv kod → xəta, heç nə silinmir
 */
const mockOtp = { sent: [], verified: [] };
let mockUser;
let mockCustomer;
const mockDeleted = [];

jest.mock('../src/services/otp.service', () => ({
  requestOtp: jest.fn(async (phone, purpose) => { mockOtp.sent.push({ phone, purpose }); return {}; }),
  verifyOtp: jest.fn(async (phone, code, purpose) => {
    mockOtp.verified.push({ phone, code, purpose });
    if (code !== '123456') {
      const { AppError } = require('../src/utils/errors');
      throw new AppError('INVALID_OTP', 'Kod yanlışdır', 400);
    }
  }),
}));
jest.mock('../src/models', () => ({
  User: {
    findOne: jest.fn(async (q) => (mockUser && q.phone === mockUser.phone ? mockUser : null)),
    findById: jest.fn(async () => mockUser),
  },
  Customer: {
    findOne: jest.fn(async () => mockCustomer),
    updateOne: jest.fn(async () => { mockDeleted.push('customer'); }),
  },
  Order: { find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) }) },
  SavedPlace: { deleteMany: jest.fn(async () => {}) },
  ScheduledRide: { deleteMany: jest.fn(async () => {}) },
  RefreshToken: { deleteMany: jest.fn(async () => {}) },
  AuditLog: { create: jest.fn(async (doc) => { mockDeleted.push(doc.reason); }) },
}));
jest.mock('../src/services/appVersion.service', () => ({}));
jest.mock('../src/services/newsImage.service', () => ({ stream: jest.fn() }));
jest.mock('../src/services/avatar.service', () => ({ stream: jest.fn(), removeByUrl: jest.fn(async () => {}) }));
jest.mock('../src/services/maintenance.service', () => ({ getStatus: jest.fn() }));

const customerAccount = require('../src/services/customerAccount.service');

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../src/utils/errors');

const app = express();
app.use(express.json());
app.use('/app', require('../src/routes/app.routes'));
app.use(errorHandler);

beforeEach(() => {
  mockOtp.sent = [];
  mockOtp.verified = [];
  mockDeleted.length = 0;
  mockUser = { _id: 'u1', role: 'CUSTOMER', phone: '+994501112233', isActive: true, save: jest.fn(async () => {}) };
  mockCustomer = { _id: 'c1', userId: 'u1', deletedAt: null };
});

test('hesab varsa kod göndərilir', async () => {
  const res = await request(app).post('/app/account-deletion/request').send({ phone: '050 111 22 33' });
  expect(res.status).toBe(200);
  expect(res.body.data.sent).toBe(true);
  expect(mockOtp.sent).toEqual([{ phone: '+994501112233', purpose: 'delete' }]);
});

test('hesab yoxdursa cavab eynidir, SMS getmir', async () => {
  mockUser = null;
  const res = await request(app).post('/app/account-deletion/request').send({ phone: '+994509998877' });
  expect(res.status).toBe(200);
  expect(res.body.data.sent).toBe(true);
  expect(mockOtp.sent).toHaveLength(0);
});

test('səhv kod: silinmir', async () => {
  const res = await request(app).post('/app/account-deletion/confirm').send({ phone: '+994501112233', code: '000000' });
  expect(res.status).toBe(400);
  expect(mockOtp.verified[0].purpose).toBe('delete');
});

test('kod formatı yoxlanılır', async () => {
  const res = await request(app).post('/app/account-deletion/confirm').send({ phone: '+994501112233', code: '12' });
  expect(res.status).toBe(400);
  expect(mockOtp.verified).toHaveLength(0);
});

test('düzgün kod: hesab silinir, səbəb "[sayt]" qeydi ilə yazılır', async () => {
  const res = await request(app).post('/app/account-deletion/confirm').send({ phone: '+994501112233', code: '123456', reason: 'Tətbiqi silmişəm' });
  expect(res.status).toBe(200);
  expect(res.body.data.deleted).toBe(true);
  expect(mockUser.isActive).toBe(false);
  expect(mockUser.phone.startsWith('deleted:')).toBe(true);
  expect(mockDeleted).toContain('customer');
  expect(mockDeleted).toContain('[sayt] Tətbiqi silmişəm');
});
