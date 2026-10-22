/** Admin hesabı bloklayanda / bloku qaldıranda sürücüyə dərhal socket hadisəsi gedir. */
const mockEmits = [];
jest.mock('../src/websocket/emitter', () => ({
  toDriver: (id, event, payload) => mockEmits.push({ id, event, payload }),
}));
jest.mock('../src/models', () => ({
  Driver: {
    findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ _id: 'd1', fcmToken: null }) }) })),
    updateOne: jest.fn(() => ({ catch: () => {} })),
  },
}));
delete process.env.FIREBASE_SERVICE_ACCOUNT;
const push = require('../src/services/push.service');

beforeEach(() => (mockEmits.length = 0));

test.each([
  ['activated', 'Blok qaldırıldı'],
  ['blocked', 'Hesabınız bloklandı'],
  ['verified', 'Hesabınız təsdiqləndi'],
])('%s → account_status socket event', async (kind, title) => {
  await push.notifyAccount('d1', kind);
  expect(mockEmits).toEqual([{ id: 'd1', event: 'account_status', payload: expect.objectContaining({ kind, title }) }]);
});

test('unknown kind sends nothing', async () => {
  await push.notifyAccount('d1', 'whatever');
  expect(mockEmits).toHaveLength(0);
});
