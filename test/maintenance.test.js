/**
 * Texniki işlər rejimi:
 *  - GET /app/status (girişsiz) rejimi qaytarır
 *  - setStatus: yandırma / söndürmə (söndürəndə mətn və vaxt təmizlənir), socket yayımı
 *  - blockDuringMaintenance: rejim açıqdırsa 503 MAINTENANCE (details.until ilə), bağlıdırsa keçir
 */
const mockStore = {};
const mockEmits = [];

jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn(async () => ({ maintenanceEnabled: false, maintenanceMessage: '', maintenanceUntil: null, ...mockStore })),
  setSetting: jest.fn(async (k, v) => { mockStore[k] = v; }),
}));
jest.mock('../src/websocket/emitter', () => ({
  toCustomers: (event, payload) => mockEmits.push({ to: 'customers', event, payload }),
  toAdminsFor: (city, event, payload) => mockEmits.push({ to: 'admin', event, payload }),
}));
jest.mock('../src/services/appVersion.service', () => ({}));
jest.mock('../src/services/newsImage.service', () => ({ stream: jest.fn() }));
jest.mock('../src/services/avatar.service', () => ({ stream: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { errorHandler, ok } = require('../src/utils/errors');
const maintenance = require('../src/services/maintenance.service');

const app = express();
app.use(express.json());
app.use('/app', require('../src/routes/app.routes'));
app.post('/orders', maintenance.blockDuringMaintenance, (req, res) => ok(res, { created: true }, {}, 201));
app.use(errorHandler);

beforeEach(() => {
  Object.keys(mockStore).forEach((k) => delete mockStore[k]);
  mockEmits.length = 0;
});

test('rejim bağlıdır: status false, sifariş keçir', async () => {
  const s = await request(app).get('/app/status');
  expect(s.status).toBe(200);
  expect(s.body.data.maintenance).toEqual({ enabled: false, message: '', until: null });

  const o = await request(app).post('/orders').send({});
  expect(o.status).toBe(201);
});

test('rejim açılır: status, socket yayımı və 503 MAINTENANCE', async () => {
  const until = '2026-11-01T10:30:00.000Z';
  const r = await maintenance.setStatus({ enabled: true, message: 'Saat 14:30-a qədər yeniləmə gedir', until });
  expect(r).toEqual({ enabled: true, message: 'Saat 14:30-a qədər yeniləmə gedir', until });
  expect(mockEmits.find((e) => e.to === 'customers' && e.event === 'maintenance_changed').payload.enabled).toBe(true);

  const s = await request(app).get('/app/status');
  expect(s.body.data.maintenance.enabled).toBe(true);

  const o = await request(app).post('/orders').send({});
  expect(o.status).toBe(503);
  expect(o.body.error.code).toBe('MAINTENANCE');
  expect(o.body.error.details.until).toBe(until);
});

test('söndürəndə mətn və vaxt təmizlənir', async () => {
  await maintenance.setStatus({ enabled: true, message: 'x', until: '2026-11-01T10:30:00Z' });
  const r = await maintenance.setStatus({ enabled: false, message: 'qalmamalıdır' });
  expect(r).toEqual({ enabled: false, message: '', until: null });
  const o = await request(app).post('/orders').send({});
  expect(o.status).toBe(201);
});

test('yanlış vaxt null olur', async () => {
  const r = await maintenance.setStatus({ enabled: true, until: 'sabah' });
  expect(r.until).toBeNull();
});
