require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const { Order, Driver } = require('../models');
const { OrderStatus } = require('../utils/orderStatus');
const { getSettings } = require('../services/settings.service');
const realtime = require('../websocket/emitter');

async function expireStaleOrders() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - (settings.orderSearchTimeoutSeconds || 120) * 1000);
  const stale = await Order.find({
    status: OrderStatus.SEARCHING_DRIVER,
    createdAt: { $lt: cutoff },
  });
  for (const order of stale) {
    order.status = OrderStatus.EXPIRED;
    await order.save();
    realtime.toCustomer(order.customerId, 'order_status_changed', {
      orderId: order._id,
      status: OrderStatus.EXPIRED,
    });
  }
}

async function markStaleDrivers() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - (settings.driverLocationStaleSeconds || 45) * 1000);
  await Driver.updateMany(
    { isOnline: true, locationUpdatedAt: { $lt: cutoff } },
    { $set: { isOnline: false } }
  );
}

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('worker connected');
  setInterval(() => {
    expireStaleOrders().catch((e) => console.error(e));
    markStaleDrivers().catch((e) => console.error(e));
  }, 15000);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { expireStaleOrders, markStaleDrivers };
