/**
 * Marşrutun dəyişməsi (Bolt kimi), ləğv/gözləmə haqları, km hesabı və müştəriyə gedən sifariş.
 * DB tələb etmir: modellər mock edilir.
 */
const RULE = {
  _id: 'rule1', version: 1, active: true, vehicleType: 'basic',
  baseFareMinor: 100, perKmMinor: 50, perMinuteMinor: 0, stopFeeMinor: 30,
  minFareMinor: 200, maxFareMinor: null, surgeMultiplier: 1, bands: [],
  cancellationFeeMinor: 150, waitingFeePerMinuteMinor: 20,
};

const mockState = { driver: null, updated: null, pendingFees: [] };

jest.mock('../src/models', () => {
  const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
  return {
    PricingRule: { findOne: jest.fn(() => ({ sort: async () => RULE })) },
    Driver: { findById: jest.fn(() => ({ select: () => ({ lean: async () => mockState.driver }) })) },
    PromoCode: { findOne: jest.fn(() => lean(null)) },
    Order: { findOneAndUpdate: jest.fn(async () => mockState.updated) },
    Customer: {
      findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ pendingFees: mockState.pendingFees }) }) })),
      updateOne: jest.fn(async () => ({})),
    },
  };
});
jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn(async () => ({ maxRouteChanges: 3, freeCancelSeconds: 120, freeWaitingMinutes: 3 })),
}));
jest.mock('../src/websocket/emitter', () => ({
  toCustomer: jest.fn(), toDriver: jest.fn(), toOrder: jest.fn(),
}));
jest.mock('../src/websocket/adminFeed', () => ({ orderChanged: jest.fn() }));
jest.mock('../src/services/push.service', () => ({ sendNotification: jest.fn(async () => true) }));
jest.mock('../src/services/route.service', () => ({ routeMetrics: jest.fn(async () => null), enabled: () => false }));

const routeChange = require('../src/services/routeChange.service');
const fees = require('../src/services/fees.service');
const pricing = require('../src/services/pricing.service');
const realtime = require('../src/websocket/emitter');
const routeService = require('../src/services/route.service');
const { publicOrder } = require('../src/utils/publicOrder');

// Zaqatala mərkəzi və ~2 km şimal
const PICKUP = { lat: 41.6336, lng: 46.6431 };
const baseOrder = (over = {}) => ({
  _id: 'o1', customerId: 'c1', driverId: 'd1', status: 'DRIVER_ON_THE_WAY', version: 3,
  vehicleType: 'basic', paymentMethod: 'CASH',
  pickup: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] },
  stops: [{ lat: 41.6516, lng: 46.6431, label: 'A' }],
  pricingSnapshot: { finalPriceMinor: 300, waitingFareMinor: 0, cancellationDebtMinor: 0 },
  routeChanges: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.driver = null;
  mockState.updated = null;
  mockState.pendingFees = [];
});

describe('km hesabı (resolveTripMetrics)', () => {
  test('dağ yolu: tətbiqin km-i düz xəttdən 3.5 dəfə uzundursa da qəbul olunur', () => {
    const points = [PICKUP, { lat: 41.6426, lng: 46.6431 }]; // ~1 km düz xətt
    const r = pricing.resolveTripMetrics({ points, distanceMeters: 3500, durationMin: 9 });
    expect(r.distanceMeters).toBe(3500);
  });
  test('inandırıcı olmayan km (düz xəttdən qısa) atılır, düz xətt × 1.3 götürülür', () => {
    const points = [PICKUP, { lat: 41.6426, lng: 46.6431 }];
    const r = pricing.resolveTripMetrics({ points, distanceMeters: 100 });
    expect(r.distanceMeters).toBeGreaterThan(1250);
    expect(r.distanceMeters).toBeLessThan(1350);
  });
  test('serverin marşrutu var: tətbiqin km-i ±15% yaxındırsa saxlanılır, deyilsə server', async () => {
    const points = [PICKUP, { lat: 41.6426, lng: 46.6431 }];
    routeService.routeMetrics.mockResolvedValueOnce({ distanceMeters: 5000, durationMin: 10 });
    expect((await pricing.resolveTripMetricsAsync({ points, distanceMeters: 5400, durationMin: 11 })).distanceMeters).toBe(5400);
    routeService.routeMetrics.mockResolvedValueOnce({ distanceMeters: 5000, durationMin: 10 });
    const r = await pricing.resolveTripMetricsAsync({ points, distanceMeters: 1200, durationMin: 2 });
    expect(r).toMatchObject({ distanceMeters: 5000, durationMin: 10, source: 'server' });
  });
});

describe('marşrutun dəyişməsi', () => {
  test('səfərdən əvvəl: qiymət götürmə yerindən yeni ünvanlara yenidən hesablanır', async () => {
    const q = await routeChange.quoteRouteChange({
      order: baseOrder(),
      stops: [{ lat: 41.6516, lng: 46.6431 }, { lat: 41.6696, lng: 46.6431 }],
      distanceMeters: 4200,
      durationMin: 8,
    });
    // 100 baza + 4.2 km × 50 + 1 əlavə dayanacaq × 30 = 340
    expect(q.priceMinor).toBe(340);
    expect(q.previousPriceMinor).toBe(300);
    expect(q.differenceMinor).toBe(40);
    expect(q.traveledMeters).toBe(0);
    expect(q.inTrip).toBe(false);
  });

  test('səfər zamanı: gedilən yol (GPS) + sürücünün yerindən qalan yol', async () => {
    mockState.driver = { location: { coordinates: [46.6431, 41.6516] } };
    const q = await routeChange.quoteRouteChange({
      order: baseOrder({ status: 'TRIP_STARTED', tripMeters: 2600, startedAt: new Date(Date.now() - 6 * 60000) }),
      stops: [{ lat: 41.6696, lng: 46.6431 }],
      distanceMeters: 2400,
      durationMin: 5,
    });
    expect(q.traveledMeters).toBe(2600);
    expect(q.remainingMeters).toBe(2400);
    expect(q.distanceMeters).toBe(5000);
    // 100 + 5 km × 50 = 350
    expect(q.priceMinor).toBe(350);
    expect(q.inTrip).toBe(true);
  });

  test('gözləmə haqqı və köhnə ləğv haqqı yeni qiymətdə saxlanılır', async () => {
    const q = await routeChange.quoteRouteChange({
      order: baseOrder({ pricingSnapshot: { finalPriceMinor: 500, waitingFareMinor: 40, cancellationDebtMinor: 150 } }),
      stops: [{ lat: 41.6516, lng: 46.6431 }],
      distanceMeters: 2000,
    });
    // 100 + 2 × 50 = 200 → +40 +150
    expect(q.priceMinor).toBe(390);
  });

  test('qiymət təsdiq olunandan çox dəyişibsə 409 PRICE_CHANGED + yeni təklif', async () => {
    await expect(routeChange.applyRouteChange({
      order: baseOrder(),
      stops: [{ lat: 41.6516, lng: 46.6431 }, { lat: 41.6696, lng: 46.6431 }],
      distanceMeters: 4200,
      expectedPriceMinor: 200,
    })).rejects.toMatchObject({ code: 'PRICE_CHANGED', details: { quote: expect.objectContaining({ priceMinor: 340 }) } });
  });

  test('təsdiq: sifariş atomik yenilənir, sürücüyə order_route_changed gedir', async () => {
    mockState.updated = { ...baseOrder(), version: 4, stops: [{ lat: 41.6696, lng: 46.6431, label: 'B' }] };
    const r = await routeChange.applyRouteChange({
      order: baseOrder(),
      stops: [{ lat: 41.6516, lng: 46.6431 }, { lat: 41.6696, lng: 46.6431, label: 'B' }],
      distanceMeters: 4200,
      expectedPriceMinor: 340,
    });
    const models = require('../src/models');
    const [filter, update] = models.Order.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'o1', status: 'DRIVER_ON_THE_WAY', version: 3 });
    expect(update.$set.pricingSnapshot.finalPriceMinor).toBe(340);
    expect(update.$set.destination.coordinates).toEqual([46.6431, 41.6696]);
    expect(update.$push.routeChanges).toMatchObject({ fromPriceMinor: 300, toPriceMinor: 340 });
    expect(realtime.toDriver).toHaveBeenCalledWith('d1', 'order_route_changed', expect.objectContaining({ finalPriceMinor: 340 }));
    expect(r.quote.priceMinor).toBe(340);
  });

  test('axtarış mərhələsində və bitmiş sifarişdə dəyişmək olmur', async () => {
    for (const status of ['SEARCHING_DRIVER', 'COMPLETED', 'CUSTOMER_CANCELLED']) {
      // eslint-disable-next-line no-await-in-loop
      await expect(routeChange.quoteRouteChange({ order: baseOrder({ status }), stops: [PICKUP] }))
        .rejects.toMatchObject({ code: 'ROUTE_CHANGE_NOT_ALLOWED' });
    }
  });

  test('dəyişiklik limiti və 4-dən çox ünvan', async () => {
    await expect(routeChange.quoteRouteChange({ order: baseOrder({ routeChanges: [{}, {}, {}] }), stops: [PICKUP] }))
      .rejects.toMatchObject({ code: 'ROUTE_CHANGE_LIMIT' });
    await expect(routeChange.quoteRouteChange({ order: baseOrder(), stops: [PICKUP, PICKUP, PICKUP, PICKUP, PICKUP] }))
      .rejects.toMatchObject({ code: 'TOO_MANY_STOPS' });
  });
});

describe('ləğv və gözləmə haqları', () => {
  const settings = { freeCancelSeconds: 120, freeWaitingMinutes: 3 };
  const now = new Date('2026-11-25T10:00:00Z');

  test('qəbuldan 2 dəqiqə ərzində ləğv pulsuzdur', async () => {
    const f = await fees.cancellationFeeFor(baseOrder({ acceptedAt: new Date(now.getTime() - 60000) }), settings, now);
    expect(f.amountMinor).toBe(0);
    expect(f.freeUntil).toEqual(new Date(now.getTime() + 60000));
  });
  test('pulsuz müddət keçib → haqq', async () => {
    const f = await fees.cancellationFeeFor(baseOrder({ acceptedAt: new Date(now.getTime() - 5 * 60000) }), settings, now);
    expect(f).toMatchObject({ amountMinor: 150, reason: 'LATE_CANCEL' });
  });
  test('sürücü gəlib çatıb → haqq', async () => {
    const f = await fees.cancellationFeeFor(baseOrder({ status: 'DRIVER_ARRIVED', acceptedAt: now }), settings, now);
    expect(f).toMatchObject({ amountMinor: 150, reason: 'DRIVER_ARRIVED' });
  });
  test('növbədəki sifariş (sürücü hələ əvvəlki səfərdədir) → haqq yoxdur', async () => {
    const f = await fees.cancellationFeeFor(baseOrder({ status: 'QUEUED', acceptedAt: new Date(0) }), settings, now);
    expect(f.amountMinor).toBe(0);
  });
  test('gözləmə: 3 dəq pulsuz, sonra hər dəqiqə 20 qəpik', async () => {
    const w = await fees.waitingFeeFor(baseOrder({ arrivedAt: new Date(now.getTime() - 7.5 * 60000) }), settings, now);
    expect(w).toEqual({ amountMinor: 80, minutes: 4 });
  });
});

describe('müştəriyə gedən sifariş (publicOrder)', () => {
  test('daxili sahələr gizlədilir', () => {
    const o = publicOrder({
      _id: 'o1', status: 'SEARCHING_DRIVER', offeredToDriverIds: ['d1'], rejectedDriverIds: ['d2'],
      currentOfferDriverId: 'd3', idempotencyKey: 'k', dispatchSeq: 5, commissionApplied: true,
      pricingSnapshot: { finalPriceMinor: 300, pricingRuleId: 'r', cancellationFeeMinor: 150 },
      routeChanges: [{ fromPriceMinor: 200, toPriceMinor: 300 }],
    });
    expect(o).not.toHaveProperty('offeredToDriverIds');
    expect(o).not.toHaveProperty('rejectedDriverIds');
    expect(o).not.toHaveProperty('currentOfferDriverId');
    expect(o).not.toHaveProperty('idempotencyKey');
    expect(o.pricingSnapshot).toEqual({ finalPriceMinor: 300 });
    expect(o.routeChangeCount).toBe(1);
    expect(o.id).toBe('o1');
  });
});
