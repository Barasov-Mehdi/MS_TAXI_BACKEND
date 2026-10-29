/**
 * Müştəri xəritəsində yaxınlıqdakı sürücülər:
 *  - köhnə tətbiq (includeBusy yoxdur) → yalnız boş sürücülər (currentOrderId: null filtri qalır)
 *  - yeni tətbiq (includeBusy: true) → boş + məşğul, hər birində `busy` bayrağı; şəxsi məlumat yoxdur
 */
let mockLastQuery = null;
let mockLastLimit = null;
const mockRows = [
  { _id: 'd1', location: { coordinates: [49.85, 40.4] }, locationMeta: { heading: 90 }, currentOrderId: null },
  { _id: 'd2', location: { coordinates: [49.86, 40.41] }, locationMeta: { heading: null }, currentOrderId: 'o7' },
];

jest.mock('../src/models', () => ({
  Driver: {
    find: jest.fn((q) => {
      mockLastQuery = q;
      const chain = {
        select: () => chain,
        limit: (n) => { mockLastLimit = n; return chain; },
        lean: async () => (q.currentOrderId === null ? mockRows.filter((r) => !r.currentOrderId) : mockRows),
      };
      return chain;
    }),
  },
  Customer: {},
  Order: {},
}));
jest.mock('../src/services/settings.service', () => ({ getSettings: async () => ({ maxDriverRadius: 5000 }) }));
jest.mock('../src/websocket/adminFeed', () => ({ driverLocation: () => {} }));
jest.mock('../src/services/matching.service', () => ({}));

const { findNearbyDrivers } = require('../src/services/location.service');

test('old clients: only free drivers, unchanged filter', async () => {
  const list = await findNearbyDrivers({ latitude: 40.4, longitude: 49.85 });
  expect(mockLastQuery.currentOrderId).toBeNull();
  expect(mockLastLimit).toBe(12);
  expect(list).toHaveLength(1);
  expect(list[0].busy).toBe(false);
});

test('includeBusy: free + busy drivers with flag, no private fields', async () => {
  const list = await findNearbyDrivers({ latitude: 40.4, longitude: 49.85, includeBusy: true });
  expect('currentOrderId' in mockLastQuery).toBe(false);
  expect(list).toHaveLength(2);
  expect(list.map((d) => d.busy)).toEqual([false, true]);
  list.forEach((d) => {
    expect(Object.keys(d).sort()).toEqual(['busy', 'heading', 'id', 'latitude', 'longitude']);
    expect(d.id).not.toBe('d1');
  });
});

test('invalid coordinates → empty list', async () => {
  expect(await findNearbyDrivers({ latitude: 'x', longitude: 1, includeBusy: true })).toEqual([]);
});
