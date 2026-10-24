/** Yeniliklər + tətbiq versiyası nəzarəti. */
const settings = {};
jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn(async () => ({
    driverAndroidLatestCode: 5,
    driverAndroidLatestName: '3.2.0',
    driverAndroidMinCode: 3,
    driverAndroidNotes: '- Yeniliklər bölməsi\n• Yeniləmə xəbərdarlığı',
    driverAndroidStoreUrl: 'https://play.google.com/store/apps/details?id=com.barasdrivers',
    ...settings,
  })),
  setSetting: jest.fn(async (k, v) => { settings[k] = v; }),
}));
jest.mock('../src/models', () => ({
  News: { countDocuments: jest.fn(async () => 2), find: jest.fn(), create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() },
  Driver: { updateOne: jest.fn(async () => ({})), find: jest.fn() },
}));
jest.mock('../src/websocket/emitter', () => ({ toDriver: jest.fn(), toDrivers: jest.fn(), toAdminsFor: jest.fn() }));
jest.mock('../src/services/push.service', () => ({
  notifyNews: jest.fn(async () => true),
  notifyAppUpdate: jest.fn(async () => true),
}));

const models = require('../src/models');
const push = require('../src/services/push.service');
const realtime = require('../src/websocket/emitter');
const appVersion = require('../src/services/appVersion.service');
const news = require('../src/services/news.service');

beforeEach(() => jest.clearAllMocks());

describe('appVersion.check', () => {
  test('köhnə, amma minimumdan yuxarı → yeniləmə təklifi, məcburi deyil', async () => {
    const r = await appVersion.check({ versionCode: '4' });
    expect(r.updateAvailable).toBe(true);
    expect(r.forceUpdate).toBe(false);
    expect(r.notes).toEqual(['Yeniliklər bölməsi', 'Yeniləmə xəbərdarlığı']);
  });
  test('minimumdan aşağı → məcburi', async () => {
    const r = await appVersion.check({ versionCode: 2 });
    expect(r.forceUpdate).toBe(true);
  });
  test('ən son versiya → heç nə', async () => {
    const r = await appVersion.check({ versionCode: 5 });
    expect(r.updateAvailable).toBe(false);
    expect(r.forceUpdate).toBe(false);
  });
  test('versiya bilinmir → bloklamır', async () => {
    const r = await appVersion.check({});
    expect(r.updateAvailable).toBe(false);
    expect(r.forceUpdate).toBe(false);
  });
});

test('yeni versiya qeyd edilir və köhnə versiyalı sürücülərə push gedir', async () => {
  models.Driver.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'd1' }, { _id: 'd2' }] }) });
  const r = await appVersion.setDriverAndroid({ latestVersionCode: 6, latestVersionName: '3.3.0' }, { notify: true });
  expect(r.notified).toBe(2);
  expect(push.notifyAppUpdate).toHaveBeenCalledTimes(2);
  // açıq tətbiqlərə dərhal socket
  expect(realtime.toDrivers).toHaveBeenCalledWith(null, 'app_version_changed', expect.objectContaining({ latestVersionCode: expect.any(Number) }));
});

test('sürücünün versiyası yadda saxlanılır, boş dəyər yazılmır', async () => {
  await appVersion.rememberDriverVersion('d1', { versionCode: '4', versionName: '3.1.0' });
  expect(models.Driver.updateOne).toHaveBeenCalledWith({ _id: 'd1' }, { $set: { appVersionCode: 4, appVersionName: '3.1.0' } });
  models.Driver.updateOne.mockClear();
  await appVersion.rememberDriverVersion('d1', {});
  expect(models.Driver.updateOne).not.toHaveBeenCalled();
});

describe('news', () => {
  const cityId = '64b000000000000000000001';

  test('sürücü yalnız ümumi + öz şəhərinin xəbərlərini görür', () => {
    const q = news.visibleQuery({ cityId });
    expect(q.cityId.$in.map((x) => (x ? String(x) : null))).toEqual([null, cityId]);
    expect(q.deletedAt).toBeNull();
  });

  test('oxunmamış sayı newsSeenAt-dən sonrakı xəbərlərdir', async () => {
    const seen = new Date('2026-10-20T00:00:00Z');
    await news.unreadForDriver({ cityId, newsSeenAt: seen });
    const q = models.News.countDocuments.mock.calls[0][0];
    expect(q.publishedAt.$gt).toEqual(seen);
  });

  test('regional admin xəbəri öz şəhərinə yazır, sürücülərə socket + push gedir', async () => {
    models.News.create.mockImplementation(async (d) => ({ _id: 'n1', ...d }));
    models.Driver.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'd1' }] }) });
    const r = await news.create({ _id: 'a1' }, { isSuper: false, cityId }, { title: 'Ofis bağlıdır', body: 'Sabah ofis işləmir', cityId: null });
    expect(String(models.News.create.mock.calls[0][0].cityId)).toBe(cityId);
    expect(realtime.toDriver).toHaveBeenCalledWith('d1', 'news_published', expect.objectContaining({ title: 'Ofis bağlıdır' }));
    expect(push.notifyNews).toHaveBeenCalledTimes(1);
    expect(r.delivery).toEqual({ drivers: 1, pushed: 1, scheduled: false });
  });

  test('gələcək tarixə planlaşdırılmış xəbər dərhal elan olunmur', async () => {
    models.News.create.mockImplementation(async (d) => ({ _id: 'n2', ...d }));
    const r = await news.create({ _id: 'a1' }, { isSuper: true }, {
      title: 'Kampaniya', body: 'Həftəsonu komissiya 5%', publishedAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(r.delivery.scheduled).toBe(true);
    expect(push.notifyNews).not.toHaveBeenCalled();
  });

  test('planlaşdırılmış xəbər vaxtı çatanda bir dəfə elan olunur (silent → push yox)', async () => {
    const due = { _id: 'n3', title: 'Bayram', body: 'Təbrik', cityId: null, publishedAt: new Date(), silent: true };
    const q = (v) => ({ lean: async () => v }); // findOneAndUpdate(...).lean()
    models.News.findOneAndUpdate.mockReturnValueOnce(q(due)).mockReturnValueOnce(q(null));
    models.Driver.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'd1' }, { _id: 'd2' }] }) });
    const n = await news.announceDue();
    expect(n).toBe(1);
    expect(realtime.toDriver).toHaveBeenCalledTimes(2);
    expect(push.notifyNews).not.toHaveBeenCalled();
    expect(realtime.toAdminsFor).toHaveBeenCalledWith(null, 'admin_news', expect.objectContaining({ action: 'announced' }));
  });

  test('düzəliş və silinmə sürücülərə canlı göndərilir', async () => {
    const doc = { _id: 'n4', title: 'A', body: 'B', cityId: null, announcedAt: new Date(), publishedAt: new Date(), save: jest.fn(async () => {}) };
    models.News.findOne.mockResolvedValue(doc);
    await news.update({ isSuper: true }, '64b000000000000000000004', { title: 'Yeni başlıq' });
    expect(realtime.toDrivers).toHaveBeenCalledWith(null, 'news_updated', expect.objectContaining({ title: 'Yeni başlıq' }));
    await news.remove({ isSuper: true }, '64b000000000000000000004');
    expect(realtime.toDrivers).toHaveBeenCalledWith(null, 'news_deleted', { id: 'n4' });
  });
});
