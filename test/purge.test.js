/**
 * Tam silmə (hard delete): POST /admin/drivers/:id/purge, /admin/customers/:id/purge
 *  - yalnız baş admin (regional admin → 403)
 *  - confirm: "DELETE" məcburidir (→ 400)
 *  - düzgün sorğu servisə ötürülür (withOrders, reason)
 */
const express = require('express');
const request = require('supertest');

let mockAdmin = { _id: 'a1', role: 'ADMIN', adminCityId: null };
const mockPurgeDriver = jest.fn(async () => ({ purged: true, withOrders: false, orders: 0, ordersDeleted: 0 }));
const mockPurgeCustomer = jest.fn(async () => ({ purged: true, withOrders: true, orders: 2, ordersDeleted: 2 }));

jest.mock('../src/services/purge.service', () => ({
  purgeDriver: (...a) => mockPurgeDriver(...a),
  purgeCustomer: (...a) => mockPurgeCustomer(...a),
}));

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = mockAdmin; next(); });
  a.use('/admin', require('../src/routes/admin.purge.routes'));
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ code: err.code }));
  return a;
}

beforeEach(() => {
  mockAdmin = { _id: 'a1', role: 'ADMIN', adminCityId: null };
  mockPurgeDriver.mockClear();
  mockPurgeCustomer.mockClear();
});

test('regional admin silə bilməz', async () => {
  mockAdmin = { _id: 'a2', role: 'ADMIN', adminCityId: 'city1' };
  const r = await request(app()).post('/admin/drivers/d1/purge').send({ confirm: 'DELETE' });
  expect(r.status).toBe(403);
  expect(mockPurgeDriver).not.toHaveBeenCalled();
});

test('confirm olmadan 400', async () => {
  const r = await request(app()).post('/admin/customers/c1/purge').send({});
  expect(r.status).toBe(400);
  expect(mockPurgeCustomer).not.toHaveBeenCalled();
});

test('sürücü tam silinir', async () => {
  const r = await request(app()).post('/admin/drivers/d1/purge').send({ confirm: 'DELETE', reason: 'test' });
  expect(r.status).toBe(200);
  expect(mockPurgeDriver).toHaveBeenCalledWith('d1', expect.objectContaining({ withOrders: false, reason: 'test' }));
});

test('müştəri sifarişləri ilə birlikdə silinir', async () => {
  const r = await request(app()).post('/admin/customers/c1/purge').send({ confirm: 'DELETE', withOrders: true });
  expect(r.status).toBe(200);
  expect(mockPurgeCustomer).toHaveBeenCalledWith('c1', expect.objectContaining({ withOrders: true }));
});
