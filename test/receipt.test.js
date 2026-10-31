/**
 * PDF qəbz: GET /customers/orders/:id/receipt
 *  - bitmiş səfər → base64 PDF (bazaya heç nə yazılmır)
 *  - bitməmiş səfər → 409 RECEIPT_NOT_AVAILABLE
 *  - başqasının sifarişi → 404
 */
const OID = '665f1c2ab3c4d5e6f7a8b9c0';
let mockOrder = null;

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { _id: 'u1', role: 'CUSTOMER' };
    req.customer = { _id: 'c1', userId: 'u1', language: 'az' };
    next();
  },
  requireRoles: () => (req, res, next) => next(),
}));

jest.mock('../src/models', () => ({
  Order: { findOne: jest.fn(async (q) => (mockOrder && String(q.customerId) === 'c1' ? mockOrder : null)) },
  Driver: { findById: () => ({ populate: async () => ({ _id: 'd1', userId: 'du1', vehicleId: { make: 'Toyota', model: 'Prius', color: 'Ağ', plateNumber: '07BC007' } }) }), updateOne: jest.fn() },
  User: { findById: jest.fn(async () => ({ firstName: 'Rəşad', lastName: 'Əliyev', phone: '+994501112233' })) },
  Vehicle: { findOne: jest.fn() },
  Complaint: {}, OrderIssue: {}, Rating: {}, Customer: {}, SavedPlace: {}, ScheduledRide: {}, RefreshToken: {}, AuditLog: {}, DriverDocument: {},
}));
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

const doneOrder = () => ({
  _id: OID,
  customerId: 'c1',
  driverId: 'd1',
  status: 'COMPLETED',
  completedAt: new Date('2026-10-31T19:45:00Z'),
  pickupAddress: 'Zaqatala, Heydər Əliyev prospekti 12',
  stops: [{ address: 'Şəki, Axundzadə küçəsi 5' }],
  distanceMeters: 58300,
  durationMin: 64,
  vehicleType: 'city',
  paymentMethod: 'CASH',
  pricingSnapshot: { baseFareMinor: 150, distanceFareMinor: 2915, discountMinor: 380, finalPriceMinor: 2685 },
});

test('bitmiş səfər üçün PDF qaytarılır', async () => {
  mockOrder = doneOrder();
  const res = await request(app).get(`/customers/orders/${OID}/receipt?lang=ru`);
  expect(res.status).toBe(200);
  expect(res.body.data.mime).toBe('application/pdf');
  expect(res.body.data.fileName).toBe('Baras-qebz-A8B9C0');
  const pdf = Buffer.from(res.body.data.base64, 'base64');
  expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(5000);
});

test('bitməmiş səfər üçün 409', async () => {
  mockOrder = { ...doneOrder(), status: 'TRIP_STARTED' };
  const res = await request(app).get(`/customers/orders/${OID}/receipt`);
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('RECEIPT_NOT_AVAILABLE');
});

test('sifariş tapılmırsa 404', async () => {
  mockOrder = null;
  const res = await request(app).get(`/customers/orders/${OID}/receipt`);
  expect(res.status).toBe(404);
});
