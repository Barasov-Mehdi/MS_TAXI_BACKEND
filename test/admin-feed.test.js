jest.mock('../src/models', () => {
  const lean = (v) => ({ select: () => ({ lean: async () => v }) });
  return {
    Order: { findById: jest.fn((id) => lean({ _id: id, status: 'ACCEPTED', cityId: 'c1', driverId: 'd1', customerId: 'u1', pricingSnapshot: { finalPriceMinor: 450 } })) },
    Driver: { findById: jest.fn((id) => lean({ _id: id, userId: 'usr', cityId: 'c1', isOnline: true, isActive: true, isVerified: true, walletBalanceMinor: 900, currentOrderId: null })) },
    User: { findById: jest.fn(() => lean({ firstName: 'Əli', lastName: 'Məmmədov', phone: '+994501112233' })) },
  };
});

const mockSent = [];
jest.mock('../src/websocket/emitter', () => ({
  toAdminCity: (cityId, event, payload) => mockSent.push({ cityId, event, payload }),
}));

const feed = require('../src/websocket/adminFeed');
const pricing = require('../src/services/pricing.service');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  mockSent.length = 0;
  feed._reset();
});

test('order changes are debounced into one admin_order event for the order city', async () => {
  feed.orderChanged('o1');
  feed.orderChanged('o1');
  feed.orderChanged({ _id: 'o1' });
  await wait(400);
  const ev = mockSent.filter((e) => e.event === 'admin_order');
  expect(ev).toHaveLength(1);
  expect(ev[0].cityId).toBe('c1');
  expect(ev[0].payload.order).toMatchObject({ _id: 'o1', status: 'ACCEPTED', priceMinor: 450 });
});

test('driver change carries name, balance and reason', async () => {
  feed.driverChanged('d1', 'online');
  await wait(400);
  const ev = mockSent.find((e) => e.event === 'admin_driver');
  expect(ev.payload.reason).toBe('online');
  expect(ev.payload.driver).toMatchObject({ name: 'Əli Məmmədov', isOnline: true, walletBalanceMinor: 900, busy: false });
});

test('location is throttled per driver', () => {
  const d = { _id: 'd9', cityId: 'c2', isOnline: true, location: { coordinates: [49.8, 40.4] }, locationMeta: { heading: 90 } };
  feed.driverLocation(d);
  feed.driverLocation(d);
  feed.driverLocation(d);
  const ev = mockSent.filter((e) => e.event === 'admin_driver_location');
  expect(ev).toHaveLength(1);
  expect(ev[0].payload).toMatchObject({ driverId: 'd9', lat: 40.4, lng: 49.8, heading: 90 });
});

test('vehicle class: legacy name maps to premium, unknown stays unknown', () => {
  expect(pricing.VEHICLE_TYPES).toEqual(['basic', 'city', 'premium']);
  expect(pricing.normalizeVehicleType('BOLT')).toBe('premium');
  expect(pricing.normalizeVehicleType('premium')).toBe('premium');
  expect(pricing.normalizeVehicleType(undefined)).toBe('basic');
  expect(pricing.VEHICLE_TYPES.includes(pricing.normalizeVehicleType('truck'))).toBe(false);
});
