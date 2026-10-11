let ioRef = null;

function setIo(io) {
  ioRef = io;
}

function emit(room, event, payload) {
  if (!ioRef) return;
  ioRef.to(room).emit(event, payload);
}

module.exports = {
  setIo,
  toCustomer: (id, event, payload) => emit(`customer:${id}`, event, payload),
  toDriver: (id, event, payload) => emit(`driver:${id}`, event, payload),
  toOrder: (id, event, payload) => emit(`order:${id}`, event, payload),
  toAdmin: (event, payload) => emit('admin:operations', event, payload),
};
