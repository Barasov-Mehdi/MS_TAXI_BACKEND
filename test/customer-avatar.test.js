/**
 * Müştəri profil şəkli:
 *  POST   /customers/me/avatar  (multipart "file") → GridFS-ə yazılır, User.avatarUrl yenilənir, köhnə fayl silinir
 *  DELETE /customers/me/avatar  → avatarUrl null, fayl silinir
 *  Şəkil olmayan fayl → 400 INVALID_FILE
 */
let mockUserDoc;
const mockBucket = { uploads: [], deleted: [] };

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = mockUserDoc;
    req.customer = { _id: 'c1', userId: 'u1', deletedAt: null };
    next();
  },
  requireRoles: () => (req, res, next) => next(),
}));

jest.mock('../src/models', () => ({
  Order: {}, Complaint: {}, OrderIssue: {}, User: {}, Driver: {}, Rating: {}, Vehicle: {},
  Customer: {}, SavedPlace: {}, ScheduledRide: {}, RefreshToken: {}, AuditLog: {}, DriverDocument: {},
}));
jest.mock('../src/services/customerSupport.service', () => ({ MAX_LEN: 1000 }));
jest.mock('../src/services/news.service', () => ({}));
jest.mock('../src/websocket/adminFeed', () => ({}));

// GridFS saxtası: yazılanlar yaddaşda saxlanılır (Mongo bağlantısı lazım deyil)
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  const { Writable } = require('stream');
  function FakeBucket() {
    return {
      openUploadStreamWithId: (id, name, opts) =>
        new Writable({
          write(chunk, enc, cb) { cb(); },
          final(cb) { mockBucket.uploads.push({ id: String(id), name, mime: opts.metadata.mime }); cb(); },
        }),
      delete: async (id) => { mockBucket.deleted.push(String(id)); },
    };
  }
  const mongo = { ...actual.mongo, GridFSBucket: FakeBucket };
  return new Proxy(actual, { get: (t, k) => (k === 'mongo' ? mongo : t[k]) });
});

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../src/utils/errors');

const app = express();
app.use(express.json());
app.use('/customers', require('../src/routes/customer.routes'));
app.use(errorHandler);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const OLD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  process.env.PUBLIC_API_URL = 'https://api.example.com';
  mockBucket.uploads = [];
  mockBucket.deleted = [];
  mockUserDoc = {
    _id: 'u1',
    role: 'CUSTOMER',
    phone: '+994501112233',
    firstName: 'Əli',
    avatarUrl: `https://api.example.com/app/avatars/${OLD_ID}`,
    save: jest.fn(async () => {}),
  };
});

test('şəkil yüklənir, avatarUrl yenilənir, köhnə fayl silinir', async () => {
  const res = await request(app).post('/customers/me/avatar').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  expect(mockBucket.uploads).toHaveLength(1);
  expect(mockBucket.uploads[0].mime).toBe('image/png');
  const newUrl = `https://api.example.com/app/avatars/${mockBucket.uploads[0].id}`;
  expect(mockUserDoc.avatarUrl).toBe(newUrl);
  expect(res.body.data.user.avatarUrl).toBe(newUrl);
  expect(mockUserDoc.save).toHaveBeenCalled();
  expect(mockBucket.deleted).toEqual([OLD_ID]);
});

test('JPEG də qəbul olunur, əvvəl şəkil yoxdursa heç nə silinmir', async () => {
  mockUserDoc.avatarUrl = null;
  const res = await request(app).post('/customers/me/avatar').attach('file', JPG, { filename: 'a.jpg', contentType: 'image/jpeg' });
  expect(res.status).toBe(201);
  expect(mockBucket.uploads[0].mime).toBe('image/jpeg');
  expect(mockBucket.deleted).toEqual([]);
});

test('şəkil olmayan fayl rədd edilir', async () => {
  const res = await request(app).post('/customers/me/avatar').attach('file', Buffer.from('hello world, not an image'), { filename: 'a.jpg', contentType: 'image/jpeg' });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('INVALID_FILE');
  expect(mockUserDoc.save).not.toHaveBeenCalled();
});

test('fayl göndərilməyibsə 400', async () => {
  const res = await request(app).post('/customers/me/avatar');
  expect(res.status).toBe(400);
});

test('şəkil silinir', async () => {
  const res = await request(app).delete('/customers/me/avatar');
  expect(res.status).toBe(200);
  expect(mockUserDoc.avatarUrl).toBeNull();
  expect(res.body.data.user.avatarUrl).toBeNull();
  expect(mockBucket.deleted).toEqual([OLD_ID]);
});
