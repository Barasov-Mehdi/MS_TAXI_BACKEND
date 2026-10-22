/** Sərnişin push mətnləri və təkrarın qarşısının alınması. */
const mockOrder = { _id: 'o1', customerId: 'c1', driverId: 'd1', status: 'DRIVER_ASSIGNED', pricingSnapshot: { finalPriceMinor: 450 } };
const lean = (v) => ({ select: () => ({ lean: async () => v }) });
jest.mock('../src/models', () => ({
  Order: { findById: jest.fn(() => lean(mockOrder)) },
  Driver: { findById: jest.fn(() => lean({ userId: 'u9', vehicleId: 'v1' })) },
  User: { findById: jest.fn(() => lean({ firstName: 'Əli' })) },
  Vehicle: { findById: jest.fn(() => lean({ make: 'Toyota', model: 'Prius', color: 'Ağ', plateNumber: '10-AB-123' })) },
}));
const mockSends = [];
jest.mock('../src/services/push.service', () => ({ sendToCustomer: jest.fn(async (id, n) => { mockSends.push({ id, ...n }); return true; }) }));
const notify = require('../src/services/customerNotify');
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => { mockSends.length = 0; notify._reset(); });

test('driver assigned: name, car and plate; sent once', async () => {
  notify.onCustomerEvent('c1', 'order_status_changed', { orderId: 'o1', status: 'DRIVER_ASSIGNED' });
  notify.onCustomerEvent('c1', 'order_status_changed', { orderId: 'o1', status: 'DRIVER_ASSIGNED' });
  await flush();
  expect(mockSends).toHaveLength(1);
  expect(mockSends[0]).toMatchObject({ id: 'c1', title: 'Sürücü tapıldı', channel: 'trip', data: { orderId: 'o1' } });
  expect(mockSends[0].body).toContain('Əli');
  expect(mockSends[0].body).toContain('10-AB-123');
});

test('arrived, started, completed with price', async () => {
  notify.onCustomerEvent('c1', 'order_status_changed', { orderId: 'o1', status: 'DRIVER_ARRIVED' });
  notify.onCustomerEvent('c1', 'order_status_changed', { orderId: 'o1', status: 'TRIP_STARTED' });
  notify.onCustomerEvent('c1', 'trip_completed', { orderId: 'o1' });
  await flush();
  expect(mockSends.map((s) => s.title)).toEqual(['Sürücü çatdı', 'Səfər başladı', 'Səfər tamamlandı']);
  expect(mockSends[2].body).toContain('4.50 ₼');
});

test('customer own cancel is not pushed; driver cancel is', async () => {
  notify.onCustomerEvent('c1', 'order_cancelled', { orderId: 'o1', status: 'CUSTOMER_CANCELLED' });
  await flush();
  expect(mockSends).toHaveLength(0);
  notify.onCustomerEvent('c1', 'order_cancelled', { orderId: 'o1', status: 'DRIVER_CANCELLED' });
  await flush();
  expect(mockSends[0].title).toBe('Sifariş ləğv edildi');
});

test('unrelated statuses are ignored; chat message goes to chat channel', async () => {
  notify.onCustomerEvent('c1', 'order_status_changed', { orderId: 'o1', status: 'SEARCHING_DRIVER' });
  notify.chatMessage('c1', { orderId: 'o1', senderName: 'Əli', text: 'Çatdım' });
  await flush();
  expect(mockSends).toEqual([expect.objectContaining({ title: 'Əli', body: 'Çatdım', channel: 'chat', type: 'chat_message' })]);
});
