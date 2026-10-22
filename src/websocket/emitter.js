let ioRef = null;

function setIo(io) {
  ioRef = io;
}

function emit(room, event, payload) {
  if (!ioRef) return;
  ioRef.to(room).emit(event, payload);
}

/** Sifarişin otağı + sərnişin və sürücünün şəxsi otaqları (eyni soket üçün hadisə bir dəfə çatır). */
function emitToParties(order, event, payload) {
  if (!ioRef || !order) return;
  let target = ioRef.to(`order:${order._id}`);
  if (order.customerId) target = target.to(`customer:${order.customerId}`);
  if (order.driverId) target = target.to(`driver:${order.driverId}`);
  target.emit(event, payload);
}

// Bu hadisələr sifarişin/sürücünün vəziyyətinin dəyişdiyini bildirir - admin panelə də ötürülür
const ORDER_EVENTS = new Set(['order_status_changed', 'order_cancelled', 'trip_completed', 'order_expired', 'driver_assigned']);
const DRIVER_EVENTS = { balance_updated: 'balance', driver_offline: 'offline', documents_updated: 'documents', queued_order_activated: 'order', account_status: 'account' };
const feed = () => require('./adminFeed');

module.exports = {
  setIo,
  toCustomer: (id, event, payload) => {
    emit(`customer:${id}`, event, payload);
    if (ORDER_EVENTS.has(event) && payload && payload.orderId) feed().orderChanged(payload.orderId);
  },
  toDriver: (id, event, payload) => {
    emit(`driver:${id}`, event, payload);
    if (DRIVER_EVENTS[event]) feed().driverChanged(id, DRIVER_EVENTS[event]);
  },
  toOrder: (id, event, payload) => {
    emit(`order:${id}`, event, payload);
    if (ORDER_EVENTS.has(event)) feed().orderChanged(id);
  },
  // Baş adminlər (admin:operations)
  toAdmin: (event, payload) => emit('admin:operations', event, payload),
  // Baş adminlər + həmin şəhərin regional adminləri
  toAdminCity: (cityId, event, payload) => {
    if (!ioRef) return;
    let t = ioRef.to('admin:operations');
    if (cityId) t = t.to(`admin:city:${cityId}`);
    t.emit(event, payload);
  },
  toParties: emitToParties,
};
