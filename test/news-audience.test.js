/** Yeniliklər: sürücülərə ayrıca, müştərilərə ayrıca, hamıya. */
const mockState = { created: null };
jest.mock('../src/models', () => {
  const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
  return {
    News: {
      create: jest.fn(async (doc) => {
        mockState.created = { _id: '64b000000000000000000777', ...doc };
        return mockState.created;
      }),
      find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })),
      countDocuments: jest.fn(async () => 3),
    },
    Driver: { find: jest.fn(() => lean([{ _id: 'd1' }, { _id: 'd2' }])), updateOne: jest.fn(async () => ({})) },
    Customer: {
      find: jest.fn(() => lean([{ _id: 'c1' }, { _id: 'c2' }, { _id: 'c3' }])),
      countDocuments: jest.fn(async () => 3),
      updateOne: jest.fn(async () => ({})),
    },
  };
});
jest.mock('../src/websocket/emitter', () => ({
  toDriver: jest.fn(),
  toDrivers: jest.fn(),
  toCustomers: jest.fn(),
  toAdminsFor: jest.fn(),
}));
jest.mock('../src/services/push.service', () => ({
  notifyNews: jest.fn(async () => true),
  sendToCustomer: jest.fn(async () => true),
}));
jest.mock('../src/services/newsImage.service', () => ({ urlFor: () => null, remove: () => {} }));

const models = require('../src/models');
const rt = require('../src/websocket/emitter');
const push = require('../src/services/push.service');
const news = require('../src/services/news.service');

const SUPER = { isSuper: true };
const REGIONAL = { isSuper: false, cityId: '64b000000000000000000001' };
const admin = { _id: 'a1' };

beforeEach(() => jest.clearAllMocks());

test('yalnız sürücülər: müştərilərə heç nə getmir (köhnə davranış, audience verilməsə)', async () => {
  const r = await news.create(admin, SUPER, { title: 'Qayda', body: 'Yeni qayda' });
  expect(mockState.created.audience).toBe('drivers');
  expect(r.news.audience).toBe('drivers');
  expect(r.delivery.drivers).toBe(2);
  expect(push.notifyNews).toHaveBeenCalledTimes(2);
  expect(rt.toCustomers).not.toHaveBeenCalled();
  expect(push.sendToCustomer).not.toHaveBeenCalled();
});

test('yalnız müştərilər: sürücülərə heç nə getmir, müştərilərə socket + push', async () => {
  const r = await news.create(admin, SUPER, { title: 'Endirim', body: 'Bu gün 20%', audience: 'customers' });
  expect(r.news.audience).toBe('customers');
  expect(r.delivery.drivers).toBe(0);
  expect(r.delivery.customers).toBe(3);
  expect(models.Driver.find).not.toHaveBeenCalled();
  expect(rt.toDriver).not.toHaveBeenCalled();
  expect(rt.toCustomers).toHaveBeenCalledWith('news_published', expect.objectContaining({ title: 'Endirim', audience: 'customers' }));
  await new Promise((res) => setImmediate(res));
  expect(push.sendToCustomer).toHaveBeenCalledTimes(3);
  expect(push.sendToCustomer.mock.calls[0][1]).toMatchObject({ type: 'news', title: 'Endirim', data: { newsId: expect.any(String) } });
});

test('hamısı: həm sürücülərə, həm müştərilərə', async () => {
  const r = await news.announce({ _id: 'n1', title: 'Bayram', body: 'Təbrik', audience: 'all', cityId: null }, { waitCustomers: true });
  expect(r.drivers).toBe(2);
  expect(r.pushed).toBe(2);
  expect(r.customers).toBe(3);
  expect(r.customerPushed).toBe(3);
  expect(rt.toDriver).toHaveBeenCalledTimes(2);
  expect(rt.toCustomers).toHaveBeenCalledTimes(1);
});

test('push söndürülübsə müştərilərə yalnız socket gedir', async () => {
  await news.create(admin, SUPER, { title: 'Səssiz', body: 'x', audience: 'customers', notify: false });
  await new Promise((res) => setImmediate(res));
  expect(rt.toCustomers).toHaveBeenCalled();
  expect(push.sendToCustomer).not.toHaveBeenCalled();
});

test('regional admin müştərilərə yaza bilməz', async () => {
  await expect(news.create(admin, REGIONAL, { title: 'X', body: 'Y', audience: 'customers' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(news.create(admin, REGIONAL, { title: 'X', body: 'Y', audience: 'all' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const r = await news.create(admin, REGIONAL, { title: 'X', body: 'Y' });
  expect(r.news.audience).toBe('drivers');
});

test('müştəri elanı şəhərə bağlana bilməz', async () => {
  await expect(
    news.create(admin, SUPER, { title: 'X', body: 'Y', audience: 'customers', cityId: '64b000000000000000000001' }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
});

test('sürücü yalnız sürücü/hamı elanlarını, müştəri yalnız müştəri/hamı elanlarını görür', () => {
  expect(news.visibleQuery({ cityId: null }).audience).toEqual({ $in: ['drivers', 'all', null] });
  expect(news.customerVisibleQuery().audience).toEqual({ $in: ['customers', 'all'] });
  expect(news.customerVisibleQuery().cityId).toBeUndefined();
});

test('müştəri oxunmamış sayı və oxundu', async () => {
  expect(await news.unreadForCustomer({ _id: 'c1', newsSeenAt: null })).toBe(3);
  await news.markReadByCustomer('c1');
  expect(models.Customer.updateOne).toHaveBeenCalledWith({ _id: 'c1' }, { $set: { newsSeenAt: expect.any(Date) } });
});
