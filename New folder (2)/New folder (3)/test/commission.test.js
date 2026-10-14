const { percentOf } = require('../src/utils/money');

function commissionMinor(fareMinor, ratingAvg, settings = {}) {
  const threshold = settings.ratingThreshold ?? 3;
  const type = settings.tripCommissionType ?? 'PERCENTAGE';
  const isLow = ratingAvg < threshold;
  const rate = isLow
    ? Number(settings.lowRatingCommission ?? 15)
    : Number(settings.tripCommission ?? 13);
  if (type === 'FIXED') return Math.round(rate);
  return percentOf(fareMinor, rate);
}

test('1000 qepik fare + rating 5 -> 130 commission (13%)', () => {
  expect(commissionMinor(1000, 5)).toBe(130);
});

test('1000 qepik fare + rating 2.5 -> 150 commission (15%)', () => {
  expect(commissionMinor(1000, 2.5)).toBe(150);
});

test('low rating replaces standard rate, does not stack', () => {
  expect(commissionMinor(1000, 2.5)).not.toBe(130 + 150);
  expect(commissionMinor(2000, 4.9)).toBe(260);
  expect(commissionMinor(2000, 2.9)).toBe(300);
});
