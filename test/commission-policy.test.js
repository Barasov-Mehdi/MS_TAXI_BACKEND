jest.mock('../src/models', () => ({}));
const { commissionPolicy } = require('../src/services/wallet.service');
const { rateFromNote } = require('../src/services/earnings.service');
const { percentOf } = require('../src/utils/money');

const settings = { tripCommissionType: 'PERCENTAGE', tripCommission: 10, lowRatingCommission: 15, ratingThreshold: 3, lowRatingInclusive: true };

describe('komissiya siyasəti: reytinq ≤ 3 → 15%, > 3 → 10%', () => {
  test.each([
    [5, 10], [4.2, 10], [3.01, 10], [3, 15], [2.99, 15], [1, 15],
  ])('reytinq %p → %p%', (rating, rate) => {
    expect(commissionPolicy(settings, rating).rate).toBe(rate);
  });
  test('reytinq yoxdursa (yeni sürücü) 5 sayılır → 10%', () => {
    expect(commissionPolicy(settings, undefined).rate).toBe(10);
  });
  test('lowRatingInclusive=false olduqda 3.0 → 10%', () => {
    expect(commissionPolicy({ ...settings, lowRatingInclusive: false }, 3).rate).toBe(10);
  });
  test('məbləğ: 8.40 ₼ sifariş, 10% → 84 qəpik; 15% → 126 qəpik', () => {
    expect(percentOf(840, 10)).toBe(84);
    expect(percentOf(840, 15)).toBe(126);
  });
});

describe('rateFromNote', () => {
  test('köhnə və yeni qeyd formatları', () => {
    expect(rateFromNote('Standart komisyon: %13')).toBe(13);
    expect(rateFromNote('Standart komissiya: 10%')).toBe(10);
    expect(rateFromNote('Aşağı reytinq komissiyası: 15% (reytinq: 2.80)')).toBe(15);
    expect(rateFromNote('')).toBeNull();
  });
});
