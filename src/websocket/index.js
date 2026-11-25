const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const config = require('../config');
const { User, Customer, Driver, Order } = require('../models');
const { setIo } = require('./emitter');
const locationService = require('../services/location.service');
const chatService = require('../services/chat.service');
const dispatchService = require('../services/dispatch.service');
const { sessionMismatch, sessionMismatchError } = require('../utils/session');

const LOCATION_MIN_INTERVAL_MS = 400; // eyni soketdən çox sıx konum yeniləməsi atılır
// Access tokenin vaxtı bitəndə soket bağlanır: tətbiq tokeni yeniləyib yenidən qoşulur (bloklanmış / çıxış etmiş
// istifadəçinin köhnə soketi saatlarla açıq qalmasın). Kiçik güzəşt: şəbəkə gecikməsi üçün.
const TOKEN_EXPIRY_GRACE_MS = 30_000;
const MAX_TIMER_MS = 2_147_000_000;

/**
 * Bir neçə server instansiyası (Heroku dyno) üçün: REDIS_URL verilibsə Socket.IO hadisələri Redis vasitəsilə
 * bütün instansiyalara paylanır. Yoxdursa (və ya paket quraşdırılmayıbsa) tək instansiya rejimi.
 */
async function attachRedisAdapter(io) {
  const url = process.env.REDIS_URL || '';
  if (!/^rediss?:\/\//i.test(url)) return false;
  try {
    // eslint-disable-next-line global-require
    const { createAdapter } = require('@socket.io/redis-adapter');
    // eslint-disable-next-line global-require
    const { createClient } = require('redis');
    const tls = url.startsWith('rediss://') ? { tls: true, rejectUnauthorized: process.env.REDIS_TLS_INSECURE !== 'true' } : {};
    const pub = createClient({ url, socket: tls });
    const sub = pub.duplicate();
    pub.on('error', (e) => console.error('[ws] redis pub', e && e.message));
    sub.on('error', (e) => console.error('[ws] redis sub', e && e.message));
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    console.log('[ws] Redis adapter aktivdir (çox instansiya rejimi)');
    return true;
  } catch (e) {
    console.error('[ws] Redis adapter qoşulmadı, tək instansiya rejimi:', e && e.message);
    return false;
  }
}

function attachWebsocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    maxHttpBufferSize: 100_000, // böyük payload ilə yaddaş doldurma hücumunun qarşısı
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  setIo(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('UNAUTHORIZED'));
      const payload = jwt.verify(token, config.jwt.accessSecret);
      const user = await User.findById(payload.sub);
      if (!user || !user.isActive) return next(new Error('UNAUTHORIZED'));
      // Bir hesab = bir cihaz: köhnə cihazın soketi qəbul edilmir (tətbiq SESSION_REPLACED görüb çıxış edir)
      if (sessionMismatch(user, payload.sid)) return next(new Error(sessionMismatchError(user).code));
      socket.data.sid = payload.sid || null;
      socket.data.exp = payload.exp || null;
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('UNAUTHORIZED'));
    }
  });

  // Hadisə handler-ləri async-dir: tutulmamış rejection Node 15+-da bütün prosesi dayandırır.
  // Hamısı bu sarğı ilə qorunur.
  const safe = (fn) => async (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      await fn(...args);
    } catch (e) {
      if (!(e && e.status && e.status < 500)) console.error('[ws] handler error', e && e.stack ? e.stack : e);
      if (cb) cb({ error: e && e.code ? e.code : 'INTERNAL_ERROR' });
    }
  };

  io.on('connection', async (socket) => {
    const user = socket.user;
    if (socket.data.exp) {
      const ms = Math.min(socket.data.exp * 1000 - Date.now() + TOKEN_EXPIRY_GRACE_MS, MAX_TIMER_MS);
      const t = setTimeout(() => {
        socket.emit('token_expired', {});
        socket.disconnect(true);
      }, Math.max(1000, ms));
      if (t.unref) t.unref();
      socket.on('disconnect', () => clearTimeout(t));
    }
    try {
      socket.join(`${user.role.toLowerCase()}:${user._id}`);
      if (user.role === 'CUSTOMER') {
        const c = await Customer.findOne({ userId: user._id });
        if (c) socket.join(`customer:${c._id}`);
        // Ümumi yayım otağı (məs. yeni tətbiq versiyası)
        socket.join('customers');
      }
      if (user.role === 'DRIVER') {
        const d = await Driver.findOne({ userId: user._id });
        if (d) {
          socket.join(`driver:${d._id}`);
          // Ümumi yayım otaqları: tətbiq versiyası, yeniliklərin dəyişməsi/silinməsi
          socket.join('drivers');
          if (d.cityId) socket.join(`drivers:city:${d.cityId}`);
          // Bağlantı qopub bərpa olubsa: vaxtı bitməmiş təklif itməsin.
          const pending = await dispatchService.getPendingOfferForDriver(d);
          if (pending) socket.emit('new_order', pending);
        }
      }
      if (user.role === 'ADMIN') {
        // Baş admin bütün hadisələri, regional admin yalnız öz şəhərininkiləri alır
        if (user.adminCityId) socket.join(`admin:city:${user.adminCityId}`);
        else socket.join('admin:operations');
        // Bütün adminlərə aid hadisələr (məs. ümumi xəbər)
        socket.join('admin:all');
      }
    } catch (e) {
      console.error('[ws] connection setup failed', e);
    }

    socket.on('join_order', safe(async (orderId, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const order = await Order.findById(orderId);
      if (!order) return reply({ error: 'ORDER_NOT_FOUND' });
      if (user.role === 'CUSTOMER') {
        const c = await Customer.findOne({ userId: user._id });
        if (!c || String(order.customerId) !== String(c._id)) return reply({ error: 'FORBIDDEN' });
      } else if (user.role === 'DRIVER') {
        const d = await Driver.findOne({ userId: user._id });
        if (!d || String(order.driverId) !== String(d._id)) return reply({ error: 'FORBIDDEN' });
      } else if (user.role !== 'ADMIN') {
        return reply({ error: 'FORBIDDEN' });
      }
      socket.join(`order:${orderId}`);
      reply({ ok: true, status: order.status });
    }));

    socket.on('driver_location_update', safe(async (payload, cb) => {
      if (user.role !== 'DRIVER') throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', status: 403 });
      const now = Date.now();
      if (socket.data.locAt && now - socket.data.locAt < LOCATION_MIN_INTERVAL_MS) {
        return typeof cb === 'function' && cb({ ok: true, throttled: true });
      }
      socket.data.locAt = now;
      const d = await Driver.findOne({ userId: user._id });
      await locationService.updateDriverLocation(d, payload);
      if (typeof cb === 'function') cb({ ok: true });
    }));

    socket.on('customer_location_update', safe(async (payload, cb) => {
      if (user.role !== 'CUSTOMER') throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', status: 403 });
      const c = await Customer.findOne({ userId: user._id });
      await locationService.updateCustomerLocation(c, payload);
      if (typeof cb === 'function') cb({ ok: true });
    }));

    // Müştəri xəritəsində yaxınlıqdakı boş sürücülər. Client hər ~10 san təkrar göndərir.
    socket.on('subscribe_nearby', async (payload) => {
      try {
        if (user.role !== 'CUSTOMER') return;
        const now = Date.now();
        if (socket.data.nearbyAt && now - socket.data.nearbyAt < 400) return;
        socket.data.nearbyAt = now;
        const drivers = await locationService.findNearbyDrivers(payload || {});
        socket.emit('nearby_drivers', { drivers });
      } catch (e) {
        socket.emit('nearby_drivers', { drivers: [] });
      }
    });

    socket.on('unsubscribe_nearby', () => {});

    socket.on('message_send', safe(async (payload, cb) => {
      // Alıcı serverdə təyin olunur; göndərən sifarişin iştirakçısı olmalıdır (chat.service yoxlayır).
      const row = await chatService.sendMessage({
        orderId: payload && payload.orderId, senderUser: user,
        message: payload && payload.message, clientMessageId: payload && payload.clientMessageId,
      });
      if (typeof cb === 'function') cb({ ok: true, message: row });
    }));
  });

  attachRedisAdapter(io).catch(() => {});
  return io;
}

module.exports = { attachWebsocket, attachRedisAdapter };
