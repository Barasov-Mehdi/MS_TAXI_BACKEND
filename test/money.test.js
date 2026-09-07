const { toMinor, toMajor, percentOf } = require('../src/utils/money');
const { canTransition, OrderStatus } = require('../src/utils/orderStatus');
const { priceFromBands } = require('../src/services/pricing.service');

test('money minor units', () => {
  expect(toMinor(1.2)).toBe(120);
  expect(toMajor(160)).toBe(1.6);
  expect(percentOf(1000, 10)).toBe(100);
});

test('state machine rejects illegal transition', () => {
  expect(canTransition(OrderStatus.COMPLETED, OrderStatus.TRIP_STARTED)).toBe(false);
  expect(canTransition(OrderStatus.SEARCHING_DRIVER, OrderStatus.QUEUED)).toBe(true);
});

test('band pricing 3.4km -> 240', () => {
  const rule = {
    baseFareMinor: 0,
    bands: [
      { fromKm: 0, toKm: 1, fareMinor: 120 },
      { fromKm: 1, toKm: 2, fareMinor: 160 },
      { fromKm: 2, toKm: 3, fareMinor: 200 },
      { fromKm: 3, toKm: 4, fareMinor: 240 },
    ],
  };
  expect(priceFromBands(3.4, rule)).toBe(240);
});
