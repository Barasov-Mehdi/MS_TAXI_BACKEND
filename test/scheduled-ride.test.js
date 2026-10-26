jest.mock('../src/models', () => ({
  ScheduledRide: { find: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(async () => ({ modifiedCount: 1 })), countDocuments: jest.fn(async () => 0), create: jest.fn(async (d) => ({ _id: 'r1', ...d })) },
  Customer: { findById: jest.fn() },
  User: { findById: jest.fn() },
  Order: { exists: jest.fn() },
}));
jest.mock('../src/services/order.service', () => ({ createOrder: jest.fn() }));
jest.mock('../src/websocket/emitter', () => ({ toCustomer: jest.fn() }));
jest.mock('../src/services/push.service', () => ({ sendToCustomer: jest.fn(async () => true) }));
jest.mock('../src/services/customerNotify', () => ({ languageOf: jest.fn(async () => 'az') }));

const models = require('../src/models');
const orderService = require('../src/services/order.service');
const push = require('../src/services/push.service');
const s = require('../src/services/scheduledRide.service');

const lean = (v) => ({ sort: () => ({ limit: () => ({ lean: async () => v }) }), limit: () => ({ lean: async () => v }) });

beforeEach(() => jest.clearAllMocks());

describe('vaxt hesabı (UTC+4)', () => {
  test('birdəfəlik: yerli 2026-11-02 08:30 = 04:30Z', () => {
    const at = s.computeNextRun({ repeat: 'once', date: '2026-11-02', time: '08:30' }, new Date('2026-11-01T00:00:00Z'));
    expect(at.toISOString()).toBe('2026-11-02T04:30:00.000Z');
  });
  test('birdəfəlik keçmiş vaxt → null', () => {
    expect(s.computeNextRun({ repeat: 'once', date: '2026-10-01', time: '08:30' }, new Date('2026-10-27T00:00:00Z'))).toBeNull();
  });
  test('həftəlik iş günləri: bazar günü axşam → bazar ertəsi 08:30', () => {
    // 2026-11-01 bazar (yerli 20:00 = 16:00Z)
    const at = s.computeNextRun({ repeat: 'weekly', days: [1, 2, 3, 4, 5], time: '08:30' }, new Date('2026-11-01T16:00:00Z'));
    expect(at.toISOString()).toBe('2026-11-02T04:30:00.000Z');
  });
  test('həftəlik: bu günün vaxtı keçibsə növbəti uyğun gün', () => {
    // 2026-11-02 bazar ertəsi yerli 09:00 (05:00Z), plan B.e. 08:30 → növbəti bazar ertəsi
    const at = s.computeNextRun({ repeat: 'weekly', days: [1], time: '08:30' }, new Date('2026-11-02T05:00:00Z'));
    expect(at.toISOString()).toBe('2026-11-09T04:30:00.000Z');
  });
  test('gecə yarısından sonra yerli tarix düzgün götürülür', () => {
    // 2026-11-02 21:30Z = yerli 2026-11-03 01:30 (çərşənbə axşamı)
    const at = s.computeNextRun({ repeat: 'weekly', days: [2], time: '07:00' }, new Date('2026-11-02T21:30:00Z'));
    expect(at.toISOString()).toBe('2026-11-03T03:00:00.000Z');
  });
  test('yanlış saat / gün rədd edilir', () => {
    expect(() => s.parseSchedule({ repeat: 'weekly', days: [], time: '08:30' })).toThrow();
    expect(() => s.parseSchedule({ repeat: 'once', date: '2026-02-30', time: '08:30' })).toThrow();
    expect(() => s.parseSchedule({ repeat: 'once', date: '2026-11-02', time: '24:00' })).toThrow();
  });
});

describe('icra', () => {
  const ride = {
    _id: 'r1', customerId: 'c1', userId: 'u1', title: 'İşə', repeat: 'weekly', days: [1, 2, 3, 4, 5], time: '08:30',
    pickup: { lat: 41.6, lng: 46.6, label: 'Ev', address: '' }, stops: [{ lat: 41.62, lng: 46.64, label: 'İş', address: '' }],
    vehicleType: 'basic', active: true,
  };

  test('vaxtı çatan plan sifariş yaradır və növbəti icra təyin olunur', async () => {
    const runAt = new Date('2026-11-02T04:30:00Z');
    models.ScheduledRide.find.mockReturnValue(lean([{ ...ride, nextRunAt: runAt }]));
    models.ScheduledRide.findOneAndUpdate.mockResolvedValue({ ...ride });
    models.Customer.findById.mockResolvedValue({ _id: 'c1' });
    models.User.findById.mockResolvedValue({ _id: 'u1', isActive: true, username: 'ali' });
    models.Order.exists.mockResolvedValue(null);
    orderService.createOrder.mockResolvedValue({ _id: 'o1' });

    const res = await s.processDue(new Date('2026-11-02T04:30:10Z'));
    expect(res).toEqual(['CREATED']);
    const claimSet = models.ScheduledRide.findOneAndUpdate.mock.calls[0][1].$set;
    expect(claimSet.nextRunAt.toISOString()).toBe('2026-11-03T04:30:00.000Z');
    expect(orderService.createOrder.mock.calls[0][0].idempotencyKey).toBe(`sched:r1:${runAt.getTime()}`);
    expect(push.sendToCustomer).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'scheduled_order' }));
  });

  test('aktiv sifariş varsa ötürülür', async () => {
    models.ScheduledRide.find.mockReturnValue(lean([{ ...ride, nextRunAt: new Date('2026-11-02T04:30:00Z') }]));
    models.ScheduledRide.findOneAndUpdate.mockResolvedValue({ ...ride });
    models.Customer.findById.mockResolvedValue({ _id: 'c1' });
    models.User.findById.mockResolvedValue({ _id: 'u1', isActive: true, username: 'ali' });
    models.Order.exists.mockResolvedValue({ _id: 'busy' });
    const res = await s.processDue(new Date('2026-11-02T04:30:05Z'));
    expect(res).toEqual(['SKIPPED_ACTIVE']);
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  test('10 dəq-dən çox gecikmiş icra buraxılır (gec maşın göndərilmir)', async () => {
    models.ScheduledRide.find.mockReturnValue(lean([{ ...ride, nextRunAt: new Date('2026-11-02T04:30:00Z') }]));
    models.ScheduledRide.findOneAndUpdate.mockResolvedValue({ ...ride });
    const res = await s.processDue(new Date('2026-11-02T05:00:00Z'));
    expect(res).toEqual(['MISSED']);
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  test('başqa instansiya götürübsə heç nə edilmir', async () => {
    models.ScheduledRide.find.mockReturnValue(lean([{ ...ride, nextRunAt: new Date('2026-11-02T04:30:00Z') }]));
    models.ScheduledRide.findOneAndUpdate.mockResolvedValue(null);
    expect(await s.processDue(new Date('2026-11-02T04:30:05Z'))).toEqual([]);
  });

  test('birdəfəlik plan icradan sonra deaktiv olur', async () => {
    const once = { ...ride, repeat: 'once', date: '2026-11-02', days: [], nextRunAt: new Date('2026-11-02T04:30:00Z') };
    models.ScheduledRide.find.mockReturnValue(lean([once]));
    models.ScheduledRide.findOneAndUpdate.mockResolvedValue(once);
    models.Customer.findById.mockResolvedValue({ _id: 'c1' });
    models.User.findById.mockResolvedValue({ _id: 'u1', isActive: true, username: 'ali' });
    models.Order.exists.mockResolvedValue(null);
    orderService.createOrder.mockResolvedValue({ _id: 'o2' });
    await s.processDue(new Date('2026-11-02T04:30:05Z'));
    expect(models.ScheduledRide.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ nextRunAt: null, active: false });
  });
});
