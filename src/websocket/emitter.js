let ioRef = null;

function setIo(io) {
  ioRef = io;
}

function emit(room, event, payload) {
  if (!ioRef) {
    console.log(`[emit] io hazır deyil, göndərilmədi: ${event} -> ${room}`);
    return;
  }
  ioRef.to(room).emit(event, payload);
  // Diaqnostika: yalnız vacib hadisələr üçün otaqda neçə soket olduğunu yaz
  if (event === 'new_order') {
    ioRef
      .in(room)
      .fetchSockets()
      .then((list) => console.log(`[emit] ${event} -> ${room} soket sayı=${list.length}`))
      .catch((e) => console.log(`[emit] fetchSockets xətası: ${e.message}`));
  }
}

module.exports = {
  setIo,
  toCustomer: (id, event, payload) => emit(`customer:${id}`, event, payload),
  toDriver: (id, event, payload) => emit(`driver:${id}`, event, payload),
  toOrder: (id, event, payload) => emit(`order:${id}`, event, payload),
  toAdmin: (event, payload) => emit('admin:operations', event, payload),
};