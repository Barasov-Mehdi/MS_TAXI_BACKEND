/**
 * Bir hesab = bir cihaz (sürücü): yeni cihazdan giriş köhnə cihazın sessiyasını bağlayır.
 */
const mockDb = { users: {}, refresh: [], drivers: {}, audit: [], kicks: [] };

jest.mock('../src/websocket/emitter', () => ({
  kickUserSessions: async (role, userId, keepSid, payload) => {
    mockDb.kicks.push({ role, userId: String(userId), keepSid, payload });
  },
  disconnectRoom: () => {},
}));

jest.mock('../src/models', () => {
  const bcrypt = require('bcryptjs');
  const match = (doc, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
    return String(doc[k]) === String(v);
  });
  const query = (val) => {
    const q = Promise.resolve(val);
    q.select = () => q;
    return q;
  };
  const User = {
    findById: async (id) => mockDb.users[String(id)] || null,
    findOne: async (q) => Object.values(mockDb.users).find((u) => match(u, q)) || null,
    updateOne: async (q, upd) => {
      const u = Object.values(mockDb.users).find((x) => match(x, q));
      if (u) Object.assign(u, upd.$set);
      return { matchedCount: u ? 1 : 0 };
    },
    hashPassword: (p) => bcrypt.hash(p, 4),
  };
  const RefreshToken = {
    create: async (doc) => {
      const row = { revoked: false, ...doc, save: async () => {} };
      mockDb.refresh.push(row);
      return row;
    },
    findOne: async (q) => mockDb.refresh.find((r) => match(r, q)) || null,
    updateMany: async (q, upd) => {
      mockDb.refresh.filter((r) => match(r, q)).forEach((r) => Object.assign(r, upd));
    },
    findOneAndUpdate: async (q, upd) => {
      const r = mockDb.refresh.find((x) => match(x, q));
      if (r) Object.assign(r, upd);
      return r || null;
    },
  };
  const Driver = {
    findOne: ({ userId }) => query(mockDb.drivers[String(userId)] || null),
    updateOne: async (q, upd) => {
      const d = mockDb.drivers[String(q.userId)];
      if (d) Object.assign(d, upd.$set);
    },
  };
  return {
    User,
    RefreshToken,
    Driver,
    Customer: { findOne: async () => ({ _id: 'c1' }) },
    AuditLog: { create: async (doc) => { mockDb.audit.push(doc); return doc; } },
  };
});

const bcrypt = require('bcryptjs');
const authService = require('../src/services/auth.service');
const { authenticate } = require('../src/middleware/auth');

const run = (token) =>
  new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/drivers/me' };
    authenticate(req, {}, (err) => resolve({ err, req }));
  });

const mkUser = async (id, role, phone) => {
  const passwordHash = await bcrypt.hash('secret1', 4);
  mockDb.users[id] = {
    _id: id, role, phone, isActive: true, passwordHash, activeSessionId: null,
    comparePassword(p) { return bcrypt.compare(p, this.passwordHash); },
    save: async () => {},
  };
};

beforeEach(async () => {
  mockDb.users = {};
  mockDb.refresh = [];
  mockDb.audit = [];
  mockDb.kicks = [];
  mockDb.drivers = { u1: { _id: 'd1', userId: 'u1', deviceSessionId: 'dev-old', fcmToken: 'fcm-old' } };
  await mkUser('u1', 'DRIVER', '+994501112233');
  await mkUser('u2', 'CUSTOMER', '+994501112244');
  delete process.env.DRIVER_SINGLE_SESSION;
});

test('ikinci cihazdan giriş: köhnə cihazın access tokeni SESSION_REPLACED alır, yenisi işləyir', async () => {
  const a = await authService.login({ phone: '+994501112233', password: 'secret1' });
  expect((await run(a.accessToken)).err).toBeUndefined();

  const b = await authService.login({ phone: '+994501112233', password: 'secret1' });
  const old = await run(a.accessToken);
  expect(old.err && old.err.code).toBe('SESSION_REPLACED');
  expect(old.err.status).toBe(401);
  expect((await run(b.accessToken)).err).toBeUndefined();
});

test('köhnə cihazın refresh tokeni SESSION_REPLACED, yeni cihazınkı işləyir', async () => {
  const a = await authService.login({ phone: '+994501112233', password: 'secret1' });
  const b = await authService.login({ phone: '+994501112233', password: 'secret1' });
  await expect(authService.refresh(a.refreshToken)).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  const r = await authService.refresh(b.refreshToken);
  expect((await run(r.accessToken)).err).toBeUndefined();
  // Rotasiya olunmuş köhnə refresh tokeni adi INVALID_REFRESH verir (eyni sessiya)
  await expect(authService.refresh(b.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH' });
});

test('girişdə köhnə cihazın native tokeni, FCM tokeni silinir və soketi bağlanır', async () => {
  const b = await authService.login({ phone: '+994501112233', password: 'secret1' });
  expect(mockDb.drivers.u1.deviceSessionId).toBeNull();
  expect(mockDb.drivers.u1.fcmToken).toBeNull();
  expect(mockDb.kicks).toHaveLength(1);
  expect(mockDb.kicks[0].keepSid).toBe(mockDb.users.u1.activeSessionId);
  expect(b.accessToken).toBeTruthy();
});

test('çıxışdan sonra köhnə token adi UNAUTHORIZED alır (başqa cihaz mesajı yox)', async () => {
  const a = await authService.login({ phone: '+994501112233', password: 'secret1' });
  await authService.logout(a.refreshToken);
  const res = await run(a.accessToken);
  expect(res.err && res.err.code).toBe('UNAUTHORIZED');
});

test('sid-siz köhnə token (yeniləmədən əvvəl) aktiv sessiya yoxdursa işləməyə davam edir', async () => {
  const t = authService.signAccess({ _id: 'u1', role: 'DRIVER' });
  expect((await run(t)).err).toBeUndefined();
});

test('sərnişin hesabına təsir etmir', async () => {
  mockDb.users.u2.activeSessionId = 'something';
  const t = authService.signAccess(mockDb.users.u2);
  expect((await run(t)).err).toBeUndefined();
});

test('DRIVER_SINGLE_SESSION=false ilə söndürülür', async () => {
  process.env.DRIVER_SINGLE_SESSION = 'false';
  const a = await authService.login({ phone: '+994501112233', password: 'secret1' });
  await authService.login({ phone: '+994501112233', password: 'secret1' });
  expect((await run(a.accessToken)).err).toBeUndefined();
});
