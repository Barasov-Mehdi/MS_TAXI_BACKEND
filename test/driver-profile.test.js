/** Sürücü profili: xülasə (göstəricilər, reytinq) və sürücünün öz hesab silmə sorğusu. */
const DRV = '111111111111111111111111';
const USR = '222222222222222222222222';

let mockUser;
let mockDriver;
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = mockUser;
    req.driver = mockDriver;
    next();
  },
  requireRoles: () => (req, res, next) => next(),
}));

const mockModels = {
  Order: { countDocuments: jest.fn() },
  TripEarning: { aggregate: jest.fn() },
  OrderStatusHistory: { countDocuments: jest.fn() },
  Rating: { aggregate: jest.fn(), find: jest.fn() },
  DriverDeleteRequest: { findOne: jest.fn(), create: jest.fn(), findOneAndUpdate: jest.fn() },
  Driver: { updateOne: jest.fn(async () => ({})) },
  Vehicle: {}, WalletTransaction: {}, OrderIssue: {}, Customer: {}, User: {},
};
jest.mock('../src/models', () => mockModels);
jest.mock('../src/services/settings.service', () => ({ getSettings: jest.fn(async () => ({})) }));
jest.mock('../src/services/order.service', () => ({}));
jest.mock('../src/services/dispatch.service', () => ({}));
jest.mock('../src/services/location.service', () => ({}));
jest.mock('../src/services/auth.service', () => ({ publicUser: (u) => u }));
jest.mock('../src/services/chat.service', () => ({}));
jest.mock('../src/services/city.service', () => ({}));
jest.mock('../src/services/support.service', () => ({ MAX_LEN: 1000 }));
jest.mock('../src/services/document.service', () => ({ MAX_BYTES: 8 * 1024 * 1024 }));
jest.mock('../src/services/news.service', () => ({}));
jest.mock('../src/services/appVersion.service', () => ({}));
jest.mock('../src/websocket/emitter', () => ({ toAdmin: jest.fn(), toAdminCity: jest.fn(), toDriver: jest.fn() }));
jest.mock('../src/websocket/adminFeed', () => ({}));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../src/utils/errors');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/drivers', require('../src/routes/driver.routes'));
  a.use(errorHandler);
  return a;
}

const chain = (value) => {
  const q = { sort: () => q, limit: () => q, select: () => q, lean: async () => value };
  return q;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { _id: USR, firstName: 'Əli', lastName: 'Məmmədov', phone: '+994501112233', createdAt: new Date('2026-01-01') };
  mockDriver = {
    _id: DRV,
    cityId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    ratingAvg: 4.6,
    ratingCount: 12,
    isOnline: true,
    currentOrderId: null,
    createdAt: new Date('2026-02-01'),
  };
});

test('summary: göstəricilər, reytinq bölgüsü və faizlər', async () => {
  mockModels.TripEarning.aggregate
    .mockResolvedValueOnce([{ trips: 40, grossMinor: 40000, commissionMinor: 4000, netMinor: 36000, distanceMeters: 200000, durationMin: 600, first: new Date('2026-02-03') }])
    .mockResolvedValueOnce([{ trips: 10, netMinor: 9000 }]);
  mockModels.Order.countDocuments.mockResolvedValue(20);
  mockModels.OrderStatusHistory.countDocuments.mockResolvedValueOnce(15).mockResolvedValueOnce(3);
  mockModels.Rating.aggregate.mockResolvedValue([{ _id: 5, n: 9 }, { _id: 4, n: 2 }, { _id: 1, n: 1 }]);
  mockModels.Rating.find.mockReturnValue(chain([{ score: 5, comment: 'Əla', createdAt: new Date() }]));
  mockModels.DriverDeleteRequest.findOne.mockReturnValue(chain(null));

  const r = await request(app()).get('/drivers/profile/summary');
  expect(r.status).toBe(200);
  const d = r.body.data;
  expect(d.driverCode).toBe('D-111111');
  expect(d.totals.trips).toBe(40);
  expect(d.performance.acceptanceRate).toBe(75);
  expect(d.performance.cancellationRate).toBe(20);
  expect(d.ratings.breakdown).toEqual({ 1: 1, 2: 0, 3: 0, 4: 2, 5: 9 });
  expect(d.ratings.recent[0].comment).toBe('Əla');
  expect(d.deleteRequest).toBeNull();
});

test('summary: təklif yoxdursa faiz null olur', async () => {
  mockModels.TripEarning.aggregate.mockResolvedValue([]);
  mockModels.Order.countDocuments.mockResolvedValue(0);
  mockModels.OrderStatusHistory.countDocuments.mockResolvedValue(0);
  mockModels.Rating.aggregate.mockResolvedValue([]);
  mockModels.Rating.find.mockReturnValue(chain([]));
  mockModels.DriverDeleteRequest.findOne.mockReturnValue(chain(null));
  const r = await request(app()).get('/drivers/profile/summary');
  expect(r.status).toBe(200);
  expect(r.body.data.performance.acceptanceRate).toBeNull();
  expect(r.body.data.performance.cancellationRate).toBeNull();
});

test('delete-request: sürücü öz hesabının silinməsini istəyir və oflayn olur', async () => {
  mockModels.DriverDeleteRequest.create.mockImplementation(async (doc) => ({ ...doc, status: 'PENDING', createdAt: new Date() }));
  const r = await request(app()).post('/drivers/me/delete-request').send({ reason: 'Artıq işləmirəm' });
  expect(r.status).toBe(201);
  const doc = mockModels.DriverDeleteRequest.create.mock.calls[0][0];
  expect(doc.selfRequested).toBe(true);
  expect(doc.driverPhone).toBe('+994501112233');
  expect(mockModels.Driver.updateOne).toHaveBeenCalledWith({ _id: DRV }, { $set: { isOnline: false, onlineSince: null } });
});

test('delete-request: aktiv sifariş varsa olmaz', async () => {
  mockDriver.currentOrderId = 'x';
  const r = await request(app()).post('/drivers/me/delete-request').send({ reason: 'Artıq işləmirəm' });
  expect(r.status).toBe(409);
  expect(mockModels.DriverDeleteRequest.create).not.toHaveBeenCalled();
});

test('delete-request: təkrar sorğu 409', async () => {
  mockModels.DriverDeleteRequest.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
  const r = await request(app()).post('/drivers/me/delete-request').send({ reason: 'Artıq işləmirəm' });
  expect(r.status).toBe(409);
});

test('delete-request: geri götürmək', async () => {
  mockModels.DriverDeleteRequest.findOneAndUpdate.mockResolvedValue({ cityId: null, status: 'CANCELLED' });
  const r = await request(app()).delete('/drivers/me/delete-request');
  expect(r.status).toBe(200);
  expect(mockModels.DriverDeleteRequest.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ driverId: DRV, status: 'PENDING', selfRequested: true });
});

describe('nəticələr (gün / həftə / ay / il)', () => {
  const { periodRange, bucketKeys } = require('../src/routes/driver.routes')._test;
  // 2026-10-25 21:00 Bakı = 17:00 UTC, bazar günü
  const now = new Date('2026-10-25T17:00:00Z');

  test('dövr sərhədləri Bakı vaxtı ilə', () => {
    expect(periodRange('day', 0, now).from.toISOString()).toBe('2026-10-24T20:00:00.000Z');
    expect(periodRange('day', 1, now).from.toISOString()).toBe('2026-10-23T20:00:00.000Z');
    // həftə bazar ertəsindən: 19 okt
    expect(periodRange('week', 0, now).from.toISOString()).toBe('2026-10-18T20:00:00.000Z');
    expect(periodRange('week', 0, now).to.toISOString()).toBe('2026-10-25T20:00:00.000Z');
    expect(periodRange('month', 0, now).from.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(periodRange('month', 10, now).from.toISOString()).toBe('2025-11-30T20:00:00.000Z');
    expect(periodRange('year', 0, now).from.toISOString()).toBe('2025-12-31T20:00:00.000Z');
  });

  test('qrafik sütunları', () => {
    const w = periodRange('week', 0, now);
    expect(bucketKeys('week', w.from, w.to)).toEqual([
      '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
    ]);
    const m = periodRange('month', 0, now);
    expect(bucketKeys('month', m.from, m.to)).toHaveLength(31);
    expect(bucketKeys('day', 0, 0)).toHaveLength(24);
    const y = periodRange('year', 0, now);
    expect(bucketKeys('year', y.from, y.to)[0]).toBe('2026-01');
  });

  test('endpoint: cəmlər, müqayisə və sıra', async () => {
    mockModels.TripEarning.aggregate
      .mockResolvedValueOnce([{ trips: 4, grossMinor: 4000, commissionMinor: 400, netMinor: 3600, distanceMeters: 20000, durationMin: 60, cashMinor: 4000 }])
      .mockResolvedValueOnce([{ trips: 2, netMinor: 1800 }])
      .mockResolvedValueOnce([{ _id: '09', trips: 1, netMinor: 900 }, { _id: '14', trips: 3, netMinor: 2700 }]);
    mockModels.OrderStatusHistory.countDocuments.mockResolvedValue(1);
    const r = await request(app()).get('/drivers/results?period=day');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totals).toMatchObject({ trips: 4, netMinor: 3600, avgPerTripMinor: 900, cancelled: 1 });
    expect(d.changePct).toBe(100);
    expect(d.series).toHaveLength(24);
    expect(d.series[14]).toEqual({ key: '14', trips: 3, netMinor: 2700 });
    expect(d.best.key).toBe('14');
  });
});
