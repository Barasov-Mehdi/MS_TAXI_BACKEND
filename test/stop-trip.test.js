jest.mock('../src/models', () => ({}));
const { traveledMetersOf } = require('../src/services/order.service');

const order = (o) => ({ distanceMeters: 10000, tripMeters: 0, pickup: { coordinates: [49.85, 40.40] }, ...o });

describe('Səfəri dayandır: gedilən yol', () => {
  test('GPS odometri varsa o istifadə olunur', () => {
    expect(traveledMetersOf(order({ tripMeters: 3200 }), 40.41, 49.86)).toBe(3200);
  });
  test('odometr yoxdursa: götürmə nöqtəsindən düz xətt × 1.3', () => {
    const m = traveledMetersOf(order({}), 40.41, 49.85); // ~1112 m şimala
    expect(m).toBeGreaterThan(1400);
    expect(m).toBeLessThan(1500);
  });
  test('tam marşrutdan çox ola bilməz', () => {
    expect(traveledMetersOf(order({ tripMeters: 25000 }), 40.41, 49.86)).toBe(10000);
  });
});
