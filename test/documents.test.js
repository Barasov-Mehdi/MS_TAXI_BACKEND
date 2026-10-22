/** Sürücü sənədləri: yalnız həqiqi şəkil qəbul olunur, xülasə düzgün hesablanır. */
jest.mock('../src/models', () => ({ DriverDocument: { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), findById: jest.fn() } }));
const models = require('../src/models');
const svc = require('../src/services/document.service');

test('fayl növü ilk baytlardan yoxlanılır', () => {
  expect(svc.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
  expect(svc.sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/png');
  expect(svc.sniff(Buffer.from('%PDF-1.7 something here'))).toBeNull();
  expect(svc.sniff(Buffer.from('<script>alert(1)</script>'))).toBeNull();
});

test('şəkil olmayan fayl və səhv növ rədd edilir', async () => {
  await expect(svc.upload('d1', 'ID_FRONT', { buffer: Buffer.from('not an image at all') })).rejects.toMatchObject({ code: 'INVALID_FILE' });
  await expect(svc.upload('d1', 'PASSPORT', { buffer: Buffer.from('x') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  await expect(svc.upload('d1', 'ID_FRONT', null)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
});

test('xülasə: 6 sənəd, hamısı təsdiqlənəndə complete=true', async () => {
  const all = svc.TYPES.map((type) => ({ _id: type, type, status: 'APPROVED' }));
  models.DriverDocument.find.mockReturnValue({ lean: async () => all });
  expect((await svc.listForDriver('d1')).summary).toMatchObject({ required: 6, approved: 6, complete: true });
  models.DriverDocument.find.mockReturnValue({ lean: async () => [{ _id: 'a', type: 'ID_FRONT', status: 'REJECTED' }] });
  const r = await svc.listForDriver('d1');
  expect(r.summary).toMatchObject({ uploaded: 1, rejected: 1, missing: 5, complete: false });
  expect(r.documents.find((d) => d.type === 'ID_BACK').status).toBe('MISSING');
});
