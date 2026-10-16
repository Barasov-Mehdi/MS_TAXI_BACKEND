jest.mock('../src/models', () => ({
  Driver: { updateOne: jest.fn().mockResolvedValue({}) },
  Customer: {},
  Order: { findById: jest.fn() },
}));
jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn().mockResolvedValue({ maxLocationAccuracyMeters: 80 }),
}));

const { Driver } = require('../src/models');
const { updateDriverLocation } = require('../src/services/location.service');

beforeEach(() => Driver.updateOne.mockClear());
const mk = (meta) => ({ _id: 'd1', currentOrderId: null, locationMeta: meta });

test('fixAgeMs locationFixAt-ı geriyə çəkir, koordinat yazılır', async () => {
  const t0 = Date.now();
  await updateDriverLocation(mk(null), { latitude: 40.4, longitude: 49.8, accuracy: 10, timestamp: t0 - 30000, fixAgeMs: 30000 });
  const set = Driver.updateOne.mock.calls[0][1].$set;
  expect(set.location.coordinates).toEqual([49.8, 40.4]);
  const age = Date.now() - set.locationFixAt.getTime();
  expect(age).toBeGreaterThanOrEqual(29900);
  expect(age).toBeLessThan(31000);
});

test('fixAgeMs göndərməyən köhnə tətbiq: koordinat təzə sayılır', async () => {
  await updateDriverLocation(mk(null), { latitude: 40.4, longitude: 49.8, accuracy: 10 });
  const set = Driver.updateOne.mock.calls[0][1].$set;
  expect(Date.now() - set.locationFixAt.getTime()).toBeLessThan(1000);
});

test('eyni GPS ölçməsinin təkrarı (heartbeat) yalnız locationUpdatedAt-ı yeniləyir', async () => {
  const ts = new Date(Date.now() - 20000);
  await updateDriverLocation(mk({ timestamp: ts }), { latitude: 40.4, longitude: 49.8, accuracy: 10, timestamp: ts.getTime(), fixAgeMs: 20000 });
  const set = Driver.updateOne.mock.calls[0][1].$set;
  expect(Object.keys(set)).toEqual(['locationUpdatedAt']);
});

test('çox qeyri-dəqiq fix koordinatı və locationFixAt-ı dəyişmir', async () => {
  await updateDriverLocation(mk(null), { latitude: 40.4, longitude: 49.8, accuracy: 500 });
  expect(Object.keys(Driver.updateOne.mock.calls[0][1].$set)).toEqual(['locationUpdatedAt']);
});

test('yanlış koordinat rədd edilir', async () => {
  await expect(updateDriverLocation(mk(null), { latitude: 'x', longitude: 1 })).rejects.toThrow();
});
