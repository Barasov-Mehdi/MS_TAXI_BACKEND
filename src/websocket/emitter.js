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

module.exports = {
  setIo,
  toCustomer: (id, event, payload) => emit(`customer:${id}`, event, payload),
  toDriver: (id, event, payload) => emit(`driver:${id}`, event, payload),
  toOrder: (id, event, payload) => emit(`order:${id}`, event, payload),
  toAdmin: (event, payload) => emit('admin:operations', event, payload),
  toParties: emitToParties,
};
