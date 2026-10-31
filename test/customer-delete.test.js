/**
 * Müştəri hesabını özü silir: POST /customers/me/delete
 *  - aktiv sifariş varsa 409 ACTIVE_ORDER, heç nə silinmir
 *  - əks halda: şəxsi məlumatlar təmizlənir, nömrə azad edilir, ünvanlar / planlı sifarişlər silinir,
 *    sessiyalar ləğv olunur, AuditLog yazılır
 */
const USER_ID = 'u1';
const CUSTOMER_ID = 'c1';

let mockOrders = [];
let mockUserDoc;
const mockCalls = {};

function mockFreshUser() {
  return {
    _id: USER_ID,
    role: 'CUSTOMER',
    phone: '+994501112233',
    firstName: 'Əli',
    lastName: 'Məmmədov',
    email: 'ali@example.com',
    username: 'ali',
    usernameLower: 'ali',
    avatarUrl: 'x.png',
    isActive: true,
    deletedPhone: null,
    save: jest.fn(async () => {}),
  };
}

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { _id: 'u1', role: 'CUSTOMER' };
    req.customer = { _id: 'c1', userId: 'u1', deletedAt: null };
    next();
  },
  requireRoles: () => (req, res, next) => next(),
}));

jest.mock('../src/models', () => {
  const track = (name) => jest.fn(async (...args) => {
    mockCalls[name] = (mockCalls[name] || 0) + 1;
    mockCalls[`${name}:args`] = args;
    return {};
  });
  return {
    Order: {
      find: jest.fn(() => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => mockOrders }) }) }) })),
    },
    User: { findById: jest.fn(async () => mockUserDoc) },
    Customer: { updateOne: track('Customer.updateOne') },
    SavedPlace: { deleteMany: track('SavedPlace.deleteMany') },
    ScheduledRide: { deleteMany: track('ScheduledRide.deleteMany') },
    RefreshToken: { deleteMany: track('RefreshToken.deleteMany') },
    AuditLog: { create: track('AuditLog.create') },
    Complaint: {}, OrderIssue: {}, Driver: {}, Rating: {}, Vehicle: {},
  };
});
jest.mock('../src/services/customerSupport.service', () => ({ MAX_LEN: 1000 }));
jest.mock('../src/services/news.service', () => ({}));
jest.mock('../src/websocket/adminFeed', () => ({}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../src/utils/errors');

const app = express();
app.use(express.json());
app.use('/customers', require('../src/routes/customer.routes'));
app.use(errorHandler);

beforeEach(() => {
  mockOrders = [];
  mockUserDoc = mockFreshUser();
  Object.keys(mockCalls).forEach((k) => delete mockCalls[k]);
});

test('aktiv sifariş varsa silinmir (409 ACTIVE_ORDER)', async () => {
  mockOrders = [{ status: 'COMPLETED' }, { status: 'DRIVER_ON_THE_WAY' }];
  const res = await request(app).post('/customers/me/delete').send({ reason: 'test' });
  expect(res.status).toBe(409);
  expect(JSON.stringify(res.body)).toContain('ACTIVE_ORDER');
  expect(mockCalls['SavedPlace.deleteMany']).toBeUndefined();
  expect(mockUserDoc.save).not.toHaveBeenCalled();
});

test('hesab silinir: şəxsi məlumatlar təmizlənir, nömrə azad edilir, sessiyalar ləğv olunur', async () => {
  mockOrders = [{ status: 'COMPLETED' }, { status: 'CUSTOMER_CANCELLED' }, { status: 'EXPIRED' }];
  const res = await request(app).post('/customers/me/delete').send({ reason: 'Artıq istifadə etmirəm' });
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).toContain('"deleted":true');

  expect(mockUserDoc.save).toHaveBeenCalled();
  expect(mockUserDoc.isActive).toBe(false);
  expect(mockUserDoc.deletedPhone).toBe('+994501112233');
  expect(mockUserDoc.phone.startsWith('deleted:')).toBe(true);
  expect(mockUserDoc.firstName).toBe('');
  expect(mockUserDoc.lastName).toBe('');
  expect(mockUserDoc.email).toBeNull();
  expect(mockUserDoc.username).toBeUndefined();
  expect(mockUserDoc.usernameLower).toBeUndefined();

  expect(mockCalls['SavedPlace.deleteMany']).toBe(1);
  expect(mockCalls['ScheduledRide.deleteMany']).toBe(1);
  expect(mockCalls['RefreshToken.deleteMany']).toBe(1);
  expect(mockCalls['Customer.updateOne']).toBe(1);
  expect(mockCalls['Customer.updateOne:args'][1].$set.deletedAt).toBeInstanceOf(Date);
  expect(mockCalls['Customer.updateOne:args'][1].$set.fcmToken).toBeNull();

  const audit = mockCalls['AuditLog.create:args'][0];
  expect(audit.action).toBe('CUSTOMER_ACCOUNT_DELETED');
  expect(audit.reason).toBe('Artıq istifadə etmirəm');
});

test('səbəbsiz də işləyir', async () => {
  const res = await request(app).post('/customers/me/delete').send({});
  expect(res.status).toBe(200);
  expect(mockCalls['AuditLog.create:args'][0].reason).toBeUndefined();
});
