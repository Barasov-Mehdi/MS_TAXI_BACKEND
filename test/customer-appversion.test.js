/** Müştəri tətbiqinin versiya nəzarəti və yeniləmə bildirişləri. */
const settings = {};
jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn(async () => ({
    driverAndroidLatestCode: 5,
    driverAndroidLatestName: '3.2.0',
    driverAndroidMinCode: 3,
    customerAndroidLatestCode: 12,
    customerAndroidLatestName: '1.4.0',
    customerAndroidMinCode: 10,
    customerAndroidNotes: ['Yeni xəritə'],
    customerAndroidStoreUrl: 'https://play.google.com/store/apps/details?id=com.barastaxi',
    driverIosLatestCode: 9,
    driverIosLatestName: '3.1.4',
    driverIosMinCode: 8,
    customerIosLatestCode: 4,
    customerIosLatestName: '1.4.0',
    customerIosStoreUrl: 'https://apps.apple.com/az/app/id123',
    ...settings,
  })),
  setSetting: jest.fn(async (k, v) => { settings[k] = v; }),
}));
jest.mock('../src/models', () => ({
  Driver: { updateOne: jest.fn(async () => ({})), find: jest.fn(), countDocuments: jest.fn(async () => 0) },
  Customer: { updateOne: jest.fn(async () => ({})), find: jest.fn(), countDocuments: jest.fn(async () => 0) },
}));
jest.mock('../src/websocket/emitter', () => ({ toDrivers: jest.fn(), toCustomers: jest.fn() }));
jest.mock('../src/services/push.service', () => ({
  notifyAppUpdate: jest.fn(async () => true),
  sendToCustomer: jest.fn(async () => true),
}));

const models = require('../src/models');
const push = require('../src/services/push.service');
const realtime = require('../src/websocket/emitter');
const appVersion = require('../src/services/appVersion.service');

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
});

test('müştəri tətbiqi üçün ayrıca versiya yoxlaması', async () => {
  const r = await appVersion.check({ app: 'customer', versionCode: 11 });
  expect(r.app).toBe('customer');
  expect(r.updateAvailable).toBe(true);
  expect(r.forceUpdate).toBe(false);
  expect((await appVersion.check({ app: 'customer', versionCode: 9 })).forceUpdate).toBe(true);
  // sürücü dəyərləri qarışmır
  expect((await appVersion.check({ app: 'driver', versionCode: 11 })).updateAvailable).toBe(false);
});

test('yeni müştəri versiyası: açıq tətbiqlərə socket + köhnələrə öz dilində push', async () => {
  models.Customer.find.mockReturnValue({
    select: () => ({ lean: async () => [{ _id: 'c1', language: 'ru' }, { _id: 'c2', language: 'az' }, { _id: 'c3' }] }),
  });
  const r = await appVersion.setInfo('customer', { latestVersionCode: 13, latestVersionName: '1.5.0', notes: [] }, { notify: true, wait: true });
  expect(r.targets).toBe(3);
  expect(r.notified).toBe(3);
  expect(realtime.toCustomers).toHaveBeenCalledWith('app_version_changed', expect.objectContaining({ app: 'customer', latestVersionCode: 13 }));
  expect(realtime.toDrivers).not.toHaveBeenCalled();
  const ru = push.sendToCustomer.mock.calls.find((c) => c[0] === 'c1')[1];
  expect(ru.title).toBe('Доступна новая версия 1.5.0');
  expect(ru.type).toBe('app_update');
  const az = push.sendToCustomer.mock.calls.find((c) => c[0] === 'c3')[1];
  expect(az.title).toBe('Yeni versiya 1.5.0 mövcuddur');
  // yalnız köhnə / versiyası bilinməyən və push tokeni olanlar
  const q = models.Customer.find.mock.calls[0][0];
  expect(q.fcmToken).toEqual({ $ne: null });
  expect(q.$and).toEqual([
    { appPlatform: { $in: ['android', null] } },
    { $or: [{ appVersionCode: { $lt: 13 } }, { appVersionCode: null }] },
  ]);
});

test('versiyanı dəyişmədən bildirişi təkrar göndərmək', async () => {
  models.Customer.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'c1', language: 'en' }] }) });
  const r = await appVersion.notifyOutdated('customer', 'android', { wait: true });
  expect(r).toEqual({ targets: 1, notified: 1 });
  expect(push.sendToCustomer.mock.calls[0][1].title).toBe('New version 1.4.0 available');
  expect(push.sendToCustomer.mock.calls[0][1].body).toBe('Yeni xəritə');
});

test('müştəri versiyası yadda saxlanılır', async () => {
  await appVersion.rememberCustomerVersion('c1', { versionCode: '12', versionName: '1.4.0' });
  expect(models.Customer.updateOne).toHaveBeenCalledWith({ _id: 'c1' }, { $set: { appVersionCode: 12, appVersionName: '1.4.0' } });
});

describe('iOS', () => {
  test('iOS versiyası Android-dən ayrıdır', async () => {
    const r = await appVersion.check({ app: 'driver', platform: 'ios', versionCode: 8 });
    expect(r.platform).toBe('ios');
    expect(r.updateAvailable).toBe(true);
    expect(r.forceUpdate).toBe(false);
    expect((await appVersion.check({ app: 'driver', platform: 'ios', versionCode: 7 })).forceUpdate).toBe(true);
    // eyni nömrə Android-də ən son versiyadan böyükdür
    expect((await appVersion.check({ app: 'driver', platform: 'android', versionCode: 8 })).updateAvailable).toBe(false);
    const c = await appVersion.check({ app: 'customer', platform: 'ios', versionCode: 3 });
    expect(c.updateAvailable).toBe(true);
    expect(c.storeUrl).toBe('https://apps.apple.com/az/app/id123');
  });

  test('iOS yeniləməsi yalnız iOS istifadəçilərinə gedir və iOS açarlarına yazılır', async () => {
    const settingsSvc = require('../src/services/settings.service');
    models.Customer.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'c9', language: 'tr' }] }) });
    const r = await appVersion.setInfo('customer', { platform: 'ios', latestVersionCode: 5, latestVersionName: '1.5.0' }, { notify: true, wait: true });
    expect(r.platform).toBe('ios');
    expect(settingsSvc.setSetting).toHaveBeenCalledWith('customerIosLatestCode', 5);
    expect(settingsSvc.setSetting).not.toHaveBeenCalledWith('customerAndroidLatestCode', expect.anything());
    const q = models.Customer.find.mock.calls[0][0];
    expect(q.$and[0]).toEqual({ appPlatform: 'ios' });
    expect(push.sendToCustomer.mock.calls[0][1].title).toBe('Yeni sürüm 1.5.0 mevcut');
    expect(realtime.toCustomers).toHaveBeenCalledWith('app_version_changed', expect.objectContaining({ platform: 'ios' }));
  });

  test('platforma ilə versiya yadda saxlanılır', async () => {
    await appVersion.rememberDriverVersion('d1', { versionCode: 9, versionName: '3.1.4', platform: 'ios' });
    expect(models.Driver.updateOne).toHaveBeenCalledWith(
      { _id: 'd1' },
      { $set: { appVersionCode: 9, appVersionName: '3.1.4', appPlatform: 'ios' } }
    );
  });
});
