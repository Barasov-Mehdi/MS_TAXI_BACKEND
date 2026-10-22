/** Sürücü ↔ ofis yazışması: oxunmamış sayğacları, hadisələr, bildiriş. */
jest.mock('../src/models', () => ({
  SupportMessage: { create: jest.fn(async (d) => ({ _id: 'm1', createdAt: new Date('2026-10-22T10:00:00Z'), ...d })) },
  SupportThread: { findOneAndUpdate: jest.fn(async () => ({ unreadForAdmin: 2, unreadForDriver: 1 })) },
  Driver: {}, User: { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'Əli', lastName: 'Məmmədov', phone: '+994501112233' }) }) }) },
}));
jest.mock('../src/websocket/emitter', () => ({ toDriver: jest.fn(), toAdminCity: jest.fn() }));
jest.mock('../src/services/push.service', () => ({ notifySupportMessage: jest.fn(async () => true) }));

const models = require('../src/models');
const realtime = require('../src/websocket/emitter');
const push = require('../src/services/push.service');
const support = require('../src/services/support.service');

const driver = { _id: 'd1', userId: 'u1', cityId: 'c1' };

beforeEach(() => jest.clearAllMocks());

test('sürücü yazır → admin üçün oxunmamış artır, şəhər adminlərinə hadisə gedir', async () => {
  const m = await support.sendFromDriver(driver, '  Balansı necə artırım?  ');
  expect(m.text).toBe('Balansı necə artırım?');
  const [, update] = models.SupportThread.findOneAndUpdate.mock.calls[0];
  expect(update.$inc).toEqual({ unreadForAdmin: 1 });
  expect(update.$set.unreadForDriver).toBe(0);
  expect(update.$set.cityId).toBe('c1');
  expect(realtime.toAdminCity).toHaveBeenCalledWith('c1', 'support_message', expect.objectContaining({ driver: expect.objectContaining({ name: 'Əli Məmmədov' }) }));
  expect(push.notifySupportMessage).not.toHaveBeenCalled();
});

test('admin yazır → sürücüyə hadisə + push, admin adı göstərilir', async () => {
  const admin = { _id: 'a1', firstName: 'Zaqatala', lastName: 'Ofisi' };
  const m = await support.sendFromAdmin(admin, driver, 'Sabah 10:00-da ofisə gəlin');
  expect(m.adminName).toBe('Zaqatala Ofisi');
  const [, update] = models.SupportThread.findOneAndUpdate.mock.calls[0];
  expect(update.$inc).toEqual({ unreadForDriver: 1 });
  expect(realtime.toDriver).toHaveBeenCalledWith('d1', 'support_message', expect.objectContaining({ text: 'Sabah 10:00-da ofisə gəlin', unread: 1 }));
  expect(push.notifySupportMessage).toHaveBeenCalledWith('d1', expect.objectContaining({ adminName: 'Zaqatala Ofisi' }));
});

test('boş və çox uzun mesaj qəbul olunmur', async () => {
  await expect(support.sendFromDriver(driver, '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  await expect(support.sendFromDriver(driver, 'a'.repeat(1001))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
});
