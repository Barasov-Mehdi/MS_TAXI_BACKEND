/**
 * Sürücü qəbul etdiyi sifarişi ləğv edəndə sifariş bağlanmır, növbəti sürücüyə ötürülür.
 */
jest.mock('../src/models', () => ({
  Order: { findOneAndUpdate: jest.fn(), findById: jest.fn() },
  Driver: { updateOne: jest.fn(), findById: jest.fn() },
  OrderStatusHistory: { create: jest.fn() },
  Customer: {}, Rating: {}, TripEarning: {},
}));
jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn(async () => ({ maxRedispatch: 5, orderDispatchTimeoutSeconds: 180 })),
}));
jest.mock('../src/services/dispatch.service', () => ({
  dispatchConfig: () => ({ timeoutSeconds: 180 }),
  startDispatch: jest.fn(async () => ({ advanced: true })),
  releaseDriverLock: jest.fn(),
}));
jest.mock('../src/websocket/emitter', () => ({
  toCustomer: jest.fn(), toDriver: jest.fn(), toOrder: jest.fn(), toParties: jest.fn(), toAdmin: jest.fn(),
}));
jest.mock('../src/services/push.service', () => ({ notifyOrderCancelled: jest.fn(async () => true) }));

const mongoose = require('mongoose');
const models = require('../src/models');
const realtime = require('../src/websocket/emitter');
const dispatch = require('../src/services/dispatch.service');
const orderService = require('../src/services/order.service');

const chainable = (value) => ({ session: () => Promise.resolve(value), then: (res, rej) => Promise.resolve(value).then(res, rej) });

beforeEach(() => {
  jest.clearAllMocks();
  const session = { withTransaction: async (fn) => fn(), endSession: jest.fn() };
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
  models.Driver.findById.mockReturnValue(chainable({ _id: 'drv', currentOrderId: null, queuedOrderIds: [], save: jest.fn() }));
});

test('DRIVER_ON_THE_WAY sifarişini sürücü ləğv edir → SEARCHING_DRIVER və növbəti sürücüyə dispatch', async () => {
  const order = { _id: 'o1', status: 'DRIVER_ON_THE_WAY', driverId: 'drv', customerId: 'cus', redispatchCount: 0 };
  models.Order.findOneAndUpdate.mockResolvedValue({ ...order, status: 'SEARCHING_DRIVER', driverId: null });
  models.Order.findById.mockResolvedValue({ ...order, status: 'SEARCHING_DRIVER', driverId: null });

  const res = await orderService.cancelOrder({ order, user: { _id: 'u' }, role: 'DRIVER', reason: 'Səhvən qəbul etdim' });

  expect(res.status).toBe('SEARCHING_DRIVER');
  const [filter, update] = models.Order.findOneAndUpdate.mock.calls[0];
  expect(filter).toEqual({ _id: 'o1', status: 'DRIVER_ON_THE_WAY', driverId: 'drv' });
  expect(update.$set.status).toBe('SEARCHING_DRIVER');
  expect(update.$set.driverId).toBeNull();
  expect(update.$addToSet.rejectedDriverIds).toBe('drv'); // eyni sürücüyə bir daha təklif getmir
  expect(dispatch.startDispatch).toHaveBeenCalledWith('o1');
  expect(realtime.toCustomer).toHaveBeenCalledWith('cus', 'order_status_changed', expect.objectContaining({ status: 'SEARCHING_DRIVER', reason: 'DRIVER_CANCELLED' }));
  expect(realtime.toDriver).not.toHaveBeenCalledWith('drv', 'order_cancelled', expect.anything());
});

test('səfər başlayıbsa (TRIP_STARTED) sürücü ləğv edə bilməz', async () => {
  const order = { _id: 'o2', status: 'TRIP_STARTED', driverId: 'drv', customerId: 'cus', version: 0, save: jest.fn() };
  await expect(orderService.cancelOrder({ order, user: { _id: 'u' }, role: 'DRIVER', reason: 'x' })).rejects.toMatchObject({
    code: 'TRIP_IN_PROGRESS',
    status: 409,
  });
  expect(order.status).toBe('TRIP_STARTED');
  expect(order.save).not.toHaveBeenCalled();
  expect(dispatch.startDispatch).not.toHaveBeenCalled();
});

test('admin səfər zamanı da ləğv edə bilər', async () => {
  const order = {
    _id: 'o5', status: 'TRIP_STARTED', driverId: 'drv', customerId: 'cus', version: 0,
    save: jest.fn().mockResolvedValue(),
  };
  const session = { startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn() };
  mongoose.startSession.mockResolvedValue(session);
  await orderService.cancelOrder({ order, user: { _id: 'admin' }, role: 'ADMIN', reason: 'x' });
  expect(order.status).toBe('ADMIN_CANCELLED');
});

test('maxRedispatch həddi keçilibsə sifariş həqiqətən ləğv olunur', async () => {
  const order = {
    _id: 'o3', status: 'DRIVER_ON_THE_WAY', driverId: 'drv', customerId: 'cus', version: 0, redispatchCount: 5,
    save: jest.fn().mockResolvedValue(),
  };
  const session = { startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn() };
  mongoose.startSession.mockResolvedValue(session);
  await orderService.cancelOrder({ order, user: { _id: 'u' }, role: 'DRIVER', reason: 'x' });
  expect(order.status).toBe('DRIVER_CANCELLED');
  expect(dispatch.startDispatch).not.toHaveBeenCalled();
});

test('sərnişin ləğvi əvvəlki kimi qalır (ötürülmür)', async () => {
  const order = {
    _id: 'o4', status: 'DRIVER_ON_THE_WAY', driverId: 'drv', customerId: 'cus', version: 0,
    save: jest.fn().mockResolvedValue(),
  };
  const session = { startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn() };
  mongoose.startSession.mockResolvedValue(session);
  await orderService.cancelOrder({ order, user: { _id: 'u' }, role: 'CUSTOMER', reason: 'x' });
  expect(order.status).toBe('CUSTOMER_CANCELLED');
  expect(dispatch.startDispatch).not.toHaveBeenCalled();
});
