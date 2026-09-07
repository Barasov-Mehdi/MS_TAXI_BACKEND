const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const config = require('../config');
const { User, Customer, Driver, Order } = require('../models');
const { setIo } = require('./emitter');
const locationService = require('../services/location.service');
const chatService = require('../services/chat.service');

function attachWebsocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });

  setIo(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('UNAUTHORIZED'));
      const payload = jwt.verify(token, config.jwt.accessSecret);
      const user = await User.findById(payload.sub);
      if (!user || !user.isActive) return next(new Error('UNAUTHORIZED'));
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    socket.join(`${user.role.toLowerCase()}:${user._id}`);
    if (user.role === 'CUSTOMER') {
      const c = await Customer.findOne({ userId: user._id });
      if (c) socket.join(`customer:${c._id}`);
    }
    if (user.role === 'DRIVER') {
      const d = await Driver.findOne({ userId: user._id });
      if (d) socket.join(`driver:${d._id}`);
    }
    if (user.role === 'ADMIN') socket.join('admin:operations');

    socket.on('join_order', async (orderId, cb) => {
      const order = await Order.findById(orderId);
      if (!order) return cb && cb({ error: 'ORDER_NOT_FOUND' });
      if (user.role === 'CUSTOMER') {
        const c = await Customer.findOne({ userId: user._id });
        if (!c || String(order.customerId) !== String(c._id)) return cb && cb({ error: 'FORBIDDEN' });
      } else if (user.role === 'DRIVER') {
        const d = await Driver.findOne({ userId: user._id });
        if (!d || String(order.driverId) !== String(d._id)) return cb && cb({ error: 'FORBIDDEN' });
      } else if (user.role !== 'ADMIN') {
        return cb && cb({ error: 'FORBIDDEN' });
      }
      socket.join(`order:${orderId}`);
      cb && cb({ ok: true, status: order.status });
    });

    socket.on('driver_location_update', async (payload, cb) => {
      try {
        if (user.role !== 'DRIVER') throw new Error('FORBIDDEN');
        const d = await Driver.findOne({ userId: user._id });
        await locationService.updateDriverLocation(d, payload);
        cb && cb({ ok: true });
      } catch (e) { cb && cb({ error: e.message }); }
    });

    socket.on('customer_location_update', async (payload, cb) => {
      try {
        if (user.role !== 'CUSTOMER') throw new Error('FORBIDDEN');
        const c = await Customer.findOne({ userId: user._id });
        await locationService.updateCustomerLocation(c, payload);
        cb && cb({ ok: true });
      } catch (e) { cb && cb({ error: e.message }); }
    });

    socket.on('message_send', async (payload, cb) => {
      try {
        const row = await chatService.sendMessage({
          orderId: payload.orderId, senderUser: user, receiverUserId: payload.receiverId,
          message: payload.message, clientMessageId: payload.clientMessageId,
        });
        cb && cb({ ok: true, message: row });
      } catch (e) { cb && cb({ error: e.message }); }
    });
  });

  return io;
}

module.exports = { attachWebsocket };
