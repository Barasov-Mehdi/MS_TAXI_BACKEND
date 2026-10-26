const { driverCanTakeNewOrder } = require('../src/services/matching.service');

const NOW = new Date('2026-10-16T10:00:00Z');
const ago = (sec) => new Date(NOW.getTime() - sec * 1000);
const settings = { driverLocationStaleSeconds: 45, driverFixMaxAgeSeconds: 60, maxLocationAccuracyMeters: 80, minimumDriverBalance: 0 };
const base = (over = {}) => ({
  isOnline: true, isActive: true, isVerified: true,
  locationUpdatedAt: ago(5), locationFixAt: ago(5),
  locationMeta: { accuracy: 10 }, walletBalanceMinor: 1000, queuedOrderIds: [], currentOrderId: null,
  ...over,
});
const gate = (d, opts) => driverCanTakeNewOrder(d, settings, NOW, opts);

test('təzə koordinatlı sürücü uyğundur', () => {
  expect(gate(base(), { requireFreshFix: true }).ok).toBe(true);
});

test('heartbeat canlıdır, amma koordinat köhnədirsə: yeni sifariş üçün uyğun deyil', () => {
  const d = base({ locationUpdatedAt: ago(3), locationFixAt: ago(600) });
  expect(gate(d, { requireFreshFix: true })).toEqual({ ok: false, reason: 'STALE_FIX' });
});

test('təklifi qəbul edərkən (requireFreshFix verilmir) koordinat yaşı yoxlanılmır', () => {
  const d = base({ locationUpdatedAt: ago(3), locationFixAt: ago(600) });
  expect(gate(d).ok).toBe(true);
});

test('locationFixAt olmayan köhnə sənəd locationUpdatedAt ilə qiymətləndirilir', () => {
  expect(gate(base({ locationFixAt: undefined }), { requireFreshFix: true }).ok).toBe(true);
  expect(gate(base({ locationFixAt: undefined, locationUpdatedAt: ago(30) }), { requireFreshFix: true }).ok).toBe(true);
});

test('heartbeat özü də kəsilibsə STALE_LOCATION', () => {
  const d = base({ locationUpdatedAt: ago(120), locationFixAt: ago(120) });
  expect(gate(d, { requireFreshFix: true }).reason).toBe('STALE_LOCATION');
});

test('dəqiqlik 80 m-dən pisdirsə BAD_ACCURACY (mövcud qayda saxlanılıb)', () => {
  expect(gate(base({ locationMeta: { accuracy: 150 } }), { requireFreshFix: true }).reason).toBe('BAD_ACCURACY');
});

describe('ehtiyat (relaxed) axtarış və qəbul', () => {
  test('koordinat 2 dəq köhnə: strict-də yox, relaxed-də uyğundur', () => {
    const d = base({ locationUpdatedAt: ago(3), locationFixAt: ago(120) });
    expect(gate(d, { requireFreshFix: true }).ok).toBe(false);
    expect(gate(d, { requireFreshFix: true, relaxed: true }).ok).toBe(true);
  });

  test('koordinat 10 dəq köhnə: relaxed-də də uyğun deyil', () => {
    const d = base({ locationUpdatedAt: ago(3), locationFixAt: ago(600) });
    expect(gate(d, { requireFreshFix: true, relaxed: true })).toEqual({ ok: false, reason: 'STALE_FIX' });
  });

  test('GPS dəqiqliyi zəif (150 m): strict BAD_ACCURACY, relaxed uyğun', () => {
    const d = base({ locationMeta: { accuracy: 150 } });
    expect(gate(d, { requireFreshFix: true })).toEqual({ ok: false, reason: 'BAD_ACCURACY' });
    expect(gate(d, { requireFreshFix: true, relaxed: true }).ok).toBe(true);
  });

  test('qəbul (forAccept): zəif GPS və köhnə heartbeat qəbulu əngəlləmir, offline isə əngəlləyir', () => {
    const d = base({ locationMeta: { accuracy: 500 }, locationUpdatedAt: ago(120), locationFixAt: ago(900) });
    expect(gate(d, { forAccept: true }).ok).toBe(true);
    expect(gate({ ...d, isOnline: false }, { forAccept: true }).ok).toBe(false);
  });
});
