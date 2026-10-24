/** Sərnişin ↔ ofis yazışması: şəhər təyini, sayğaclar, hadisələr, push, regional admin səlahiyyəti. */
jest.mock('../src/models', () => ({
  CustomerSupportMessage: {
    create: jest.fn(async (d) => ({ _id: 'm1', createdAt: new Date('2026-10-24T20:00:00Z'), ...d })),
    findOne: jest.fn(),
  },
  CustomerSupportThread: {
    findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })),
    findOneAndUpdate: jest.fn(async () => ({ cityId: 'zq', unreadForAdmin: 1, unreadForCustomer: 1 })),
  },
  Customer: { findById: jest.fn() },
  User: { findById: () => ({ select: () => ({ lean: async () => ({ firstName: 'Aysel', lastName: 'Q', phone: '+994551112233' }) }) }) },
}));
jest.mock('../src/websocket/emitter', () => ({ toCustomer: jest.fn(), toAdminCity: jest.fn() }));
jest.mock('../src/services/push.service', () => ({ sendToCustomer: jest.fn(async () => true) }));
jest.mock('../src/services/city.service', () => ({ cityForPoint: jest.fn(async () => ({ id: 'zq', name: 'Zaqatala' })) }));

const models = require('../src/models');
const realtime = require('../src/websocket/emitter');
const push = require('../src/services/push.service');
const cities = require('../src/services/city.service');
const svc = require('../src/services/customerSupport.service');

const customer = { _id: 'c1', userId: 'u1' };
beforeEach(() => jest.clearAllMocks());

test('sərnişin yazır → ən yaxın şəhər təyin olunur, həmin şəhərin adminlərinə hadisə gedir', async () => {
  const m = await svc.sendFromCustomer(customer, '  Salam, telefonumu maşında unutmuşam  ', { lat: 41.63, lng: 46.64, clientMessageId: 'x1' });
  expect(m.text).toBe('Salam, telefonumu maşında unutmuşam');
  expect(cities.cityForPoint).toHaveBeenCalledWith(41.63, 46.64);
  const [, update] = models.CustomerSupportThread.findOneAndUpdate.mock.calls[0];
  expect(update.$set.cityId).toBe('zq');
  expect(update.$inc).toEqual({ unreadForAdmin: 1 });
  expect(realtime.toAdminCity).toHaveBeenCalledWith('zq', 'customer_support_message', expect.objectContaining({ customer: expect.objectContaining({ name: 'Aysel Q' }) }));
  expect(push.sendToCustomer).not.toHaveBeenCalled();
});

test('admin cavab yazır → sərnişinə socket + ayrıca səsli "support_message" push', async () => {
  const m = await svc.sendFromAdmin({ _id: 'a1', firstName: 'Zaqatala', lastName: 'Ofisi' }, { isSuper: true }, customer, 'Sürücü ilə əlaqə saxladıq');
  expect(m.adminName).toBe('Zaqatala Ofisi');
  expect(realtime.toCustomer).toHaveBeenCalledWith('c1', 'support_message', expect.objectContaining({ sender: 'ADMIN', unread: 1 }));
  expect(push.sendToCustomer).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'support_message' }));
});

test('regional admin başqa şəhərin sərnişin yazışmasını görmür', async () => {
  models.Customer.findById.mockResolvedValue(customer);
  models.CustomerSupportThread.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ cityId: 'baku' }) }) });
  await expect(svc.loadCustomerInScope({ isSuper: false, cityId: 'zq' }, '64b000000000000000000001')).rejects.toMatchObject({ status: 404 });
  models.CustomerSupportThread.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ cityId: 'zq' }) }) });
  await expect(svc.loadCustomerInScope({ isSuper: false, cityId: 'zq' }, '64b000000000000000000001')).resolves.toBe(customer);
});

test('boş mesaj qəbul olunmur', async () => {
  await expect(svc.sendFromCustomer(customer, '   ')).rejects.toMatchObject({ status: 400 });
});
