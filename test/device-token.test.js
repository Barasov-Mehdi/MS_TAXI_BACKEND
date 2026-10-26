jest.mock('../src/models', () => {
  const users = { u1: { _id: 'u1', role: 'DRIVER', isActive: true } };
  const drivers = { u1: { _id: 'd1', userId: 'u1', deviceSessionId: 'sid-ok' } };
  const query = (val) => {
    const q = Promise.resolve(val);
    q.select = () => q;
    return q;
  };
  return {
    User: { findById: async (id) => users[id] || null },
    Customer: { findOne: async () => null },
    Driver: { findOne: ({ userId }) => query(drivers[userId] || null) },
  };
});

const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { authenticate } = require('../src/middleware/auth');
const { signDevice, signAccess } = require('../src/services/auth.service');

const run = (token, method, url) =>
  new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url };
    authenticate(req, {}, (err) => resolve({ err, req }));
  });

const ID = '5f1d7b0c9b1e8a0012345678';

test('cihaz tokeni qəbul / rədd / mövqe endpoint-lərində keçir', async () => {
  const t = signDevice({ _id: 'u1', role: 'DRIVER' }, 'sid-ok');
  for (const [m, u] of [['POST', `/drivers/orders/${ID}/accept`], ['POST', `/drivers/orders/${ID}/reject`], ['POST', '/drivers/location']]) {
    const { err, req } = await run(t, m, u);
    expect(err).toBeUndefined();
    expect(req.authScope).toBe('device');
  }
});

test('cihaz tokeni digər endpoint-lərdə rədd olunur', async () => {
  const t = signDevice({ _id: 'u1', role: 'DRIVER' }, 'sid-ok');
  const { err } = await run(t, 'GET', '/drivers/me');
  expect(err && err.status).toBe(401);
  const r2 = await run(t, 'POST', '/drivers/device-session');
  expect(r2.err && r2.err.status).toBe(401);
});

test('köhnə sessiya id-li cihaz tokeni etibarsızdır', async () => {
  const t = signDevice({ _id: 'u1', role: 'DRIVER' }, 'sid-old');
  const { err } = await run(t, 'POST', '/drivers/location');
  expect(err && err.status).toBe(401);
});

test('adi access token bütün endpoint-lərdə əvvəlki kimi işləyir', async () => {
  const { err, req } = await run(signAccess({ _id: 'u1', role: 'DRIVER' }), 'GET', '/drivers/me');
  expect(err).toBeUndefined();
  expect(req.authScope).toBe('access');
});

test('cihaz açarı ilə imzalanmış, amma scope-suz token qəbul edilmir', async () => {
  const t = jwt.sign({ sub: 'u1', role: 'DRIVER' }, `${config.jwt.accessSecret}:device`);
  const { err } = await run(t, 'POST', '/drivers/location');
  expect(err && err.status).toBe(401);
});
