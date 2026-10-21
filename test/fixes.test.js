/**
 * Regress testləri (DB tələb etmir - modellər mock edilir).
 * 1) Komissiya səfəri bloklamır  2) QUEUED ləğvi cari səfəri silmir
 * 3) Chat yalnız iştirakçılar üçün  4) "Başqası üçün" sərnişin məlumatı təmizlənir
 */
jest.mock('../src/models', () => ({
  Driver: { findOneAndUpdate: jest.fn(), findById: jest.fn(), updateOne: jest.fn(), exists: jest.fn() },
  WalletTransaction: { findOne: jest.fn(), create: jest.fn() },
  Order: { findById: jest.fn() },
  Customer: { findById: jest.fn() },
  Message: { findOne: jest.fn(), create: jest.fn(), find: jest.fn() },
  OrderStatusHistory: { create: jest.fn() },
  Rating: {},
}));
jest.mock('../src/services/settings.service', () => ({
  getSettings: jest.fn(async () => ({ negativeBalanceAllowed: false, tripCommission: 13, ratingThreshold: 3 })),
}));
jest.mock('../src/websocket/emitter', () => ({
  toCustomer: jest.fn(), toDriver: jest.fn(), toOrder: jest.fn(), toParties: jest.fn(), toAdmin: jest.fn(),
}));

const models = require('../src/models');
const realtime = require('../src/websocket/emitter');

const chainable = (value) => ({ session: () => Promise.resolve(value), then: (res, rej) => Promise.resolve(value).then(res, rej) });

describe('wallet.applyTransaction', () => {
  const wallet = require('../src/services/wallet.service');
  beforeEach(() => jest.clearAllMocks());

  test('komissiya allowNegative ilə bakiyə çatmasa da keçir (filter-də $expr yoxdur)', async () => {
    models.WalletTransaction.findOne.mockReturnValue(chainable(null));
    models.Driver.findOneAndUpdate.mockResolvedValue({ walletBalanceMinor: 0 });
    models.WalletTransaction.create.mockResolvedValue([{ amountMinor: -130 }]);
    await wallet.applyTransaction({ driverId: 'd1', type: 'TRIP_COMMISSION', amountMinor: -130, idempotencyKey: 'k1', allowNegative: true });
    const filter = models.Driver.findOneAndUpdate.mock.calls[0][0];
    expect(filter.$expr).toBeUndefined();
  });

  test('admin düzəlişi (allowNegative yox) mənfi bakiyəyə icazə vermir', async () => {
    models.WalletTransaction.findOne.mockReturnValue(chainable(null));
    models.Driver.findOneAndUpdate.mockResolvedValue({ walletBalanceMinor: 0 });
    models.WalletTransaction.create.mockResolvedValue([{}]);
    await wallet.applyTransaction({ driverId: 'd1', type: 'MANUAL_ADJUSTMENT', amountMinor: -50, idempotencyKey: 'k2' });
    expect(models.Driver.findOneAndUpdate.mock.calls[0][0].$expr).toBeDefined();
  });
});

describe('order.service.cancelOrder - QUEUED', () => {
  const mongoose = require('mongoose');
  const orderService = require('../src/services/order.service');

  test('növbədəki sifariş ləğv olanda currentOrderId yalnız eyni sifarişdirsə təmizlənir', async () => {
    const session = { startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    const order = {
      _id: 'queuedOrder', status: 'QUEUED', driverId: 'drv', customerId: 'cus', version: 0,
      save: jest.fn().mockResolvedValue(),
    };
    // Sürücünün hələ cari səfəri var: növbədən heç nə aktivləşdirilmir
    models.Driver.findById.mockReturnValue(chainable({ _id: 'drv', currentOrderId: 'currentTrip', queuedOrderIds: [] }));
    await orderService.cancelOrder({ order, user: { _id: 'u1' }, role: 'CUSTOMER', reason: 'x' });
    const calls = models.Driver.updateOne.mock.calls;
    const unsetsCurrent = calls.find(([, update]) => update.$set && 'currentOrderId' in update.$set);
    expect(unsetsCurrent[0]).toEqual({ _id: 'drv', currentOrderId: 'queuedOrder' });
    expect(calls.some(([, update]) => update.$unset)).toBe(false);
    expect(calls.some(([, update]) => update.$pull && update.$pull.queuedOrderIds === 'queuedOrder')).toBe(true);
    expect(session.commitTransaction).toHaveBeenCalled();
  });
});

describe('order.service.cancelOrder - cari səfər ləğvi növbəni aktivləşdirir', () => {
  const mongoose = require('mongoose');
  const orderService = require('../src/services/order.service');

  test('cari səfər ləğv olunanda növbədəki QUEUED sifariş DRIVER_HEADING_TO_CUSTOMER olur', async () => {
    jest.clearAllMocks();
    const session = { startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn() };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    const drv = { _id: 'drv', currentOrderId: null, queuedOrderIds: ['q1'], save: jest.fn().mockResolvedValue() };
    const queued = { _id: 'q1', status: 'QUEUED', customerId: 'cus2', version: 0, save: jest.fn().mockResolvedValue() };
    models.Driver.findById.mockReturnValue(chainable(drv));
    models.Order.findById.mockReturnValue(chainable(queued));
    const order = {
      _id: 'trip', status: 'TRIP_STARTED', driverId: 'drv', customerId: 'cus', version: 0,
      save: jest.fn().mockResolvedValue(),
    };
    await orderService.cancelOrder({ order, user: { _id: 'u1' }, role: 'CUSTOMER', reason: 'x' });
    expect(queued.status).toBe('DRIVER_HEADING_TO_CUSTOMER');
    expect(drv.currentOrderId).toBe('q1');
    expect(drv.queuedOrderIds).toEqual([]);
    expect(realtime.toDriver).toHaveBeenCalledWith('drv', 'queued_order_activated', { orderId: 'q1' });
  });
});

describe('order.service.cleanPassenger', () => {
  const { cleanPassenger } = require('../src/services/order.service');
  test('forOther yoxdursa boşaldılır', () => {
    expect(cleanPassenger({ forOther: false, name: 'Ali' })).toEqual({ forOther: false, name: '', phone: '' });
    expect(cleanPassenger(undefined)).toEqual({ forOther: false, name: '', phone: '' });
  });
  test('düzgün nömrə +994 formatına salınır, uzun ad kəsilir', () => {
    const r = cleanPassenger({ forOther: true, name: 'A'.repeat(100), phone: '050 123 45 67' });
    expect(r.forOther).toBe(true);
    expect(r.phone).toBe('+994501234567');
    expect(r.name.length).toBe(60);
  });
  test('yanlış nömrə atılır', () => {
    expect(cleanPassenger({ forOther: true, name: 'Ali', phone: '123' })).toEqual({ forOther: true, name: 'Ali', phone: '' });
  });
});

describe('chat.service', () => {
  const chat = require('../src/services/chat.service');
  const { Driver } = models;
  const lean = (v) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });
  beforeEach(() => {
    jest.clearAllMocks();
    models.Order.findById.mockResolvedValue({ _id: 'o1', customerId: 'c1', driverId: 'd1' });
    models.Customer.findById.mockReturnValue(lean({ userId: 'uCustomer' }));
    Driver.findById.mockReturnValue(lean({ userId: 'uDriver' }));
    models.Message.findOne.mockResolvedValue(null);
    models.Message.create.mockImplementation(async (d) => ({ _id: 'm1', createdAt: new Date(), ...d }));
  });

  test('kənar istifadəçi yaza bilmir', async () => {
    await expect(chat.sendMessage({ orderId: 'o1', senderUser: { _id: 'stranger' }, message: 'salam' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(models.Message.create).not.toHaveBeenCalled();
  });

  test('alıcı serverdə təyin olunur (client receiverId qəbul edilmir)', async () => {
    const row = await chat.sendMessage({ orderId: 'o1', senderUser: { _id: 'uDriver' }, message: ' salam ', receiverId: 'hacker' });
    expect(String(row.receiverId)).toBe('uCustomer');
    expect(row.message).toBe('salam');
    expect(realtime.toParties).toHaveBeenCalledWith(expect.objectContaining({ _id: 'o1' }), 'incoming_message', expect.any(Object));
  });

  test('boş və çox uzun mesaj rədd edilir', async () => {
    await expect(chat.sendMessage({ orderId: 'o1', senderUser: { _id: 'uDriver' }, message: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(chat.sendMessage({ orderId: 'o1', senderUser: { _id: 'uDriver' }, message: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('sürücü təyin olunmayıbsa mesaj göndərilmir', async () => {
    models.Order.findById.mockResolvedValue({ _id: 'o1', customerId: 'c1', driverId: null });
    await expect(chat.sendMessage({ orderId: 'o1', senderUser: { _id: 'uCustomer' }, message: 'salam' })).rejects.toMatchObject({ code: 'NO_DRIVER' });
  });
});
