const { normalizePhone, parseUsername } = require('../src/utils/validators');

test('normalizePhone accepts common AZ formats', () => {
  expect(normalizePhone('+994501234567')).toBe('+994501234567');
  expect(normalizePhone('994501234567')).toBe('+994501234567');
  expect(normalizePhone('050 123 45 67')).toBe('+994501234567');
  expect(normalizePhone('501234567')).toBe('+994501234567');
});

test('normalizePhone rejects invalid numbers', () => {
  expect(normalizePhone('')).toBeNull();
  expect(normalizePhone('12345')).toBeNull();
  expect(normalizePhone('+994121234567')).toBeNull(); // sabit nömrə
  expect(normalizePhone('+9945012345678')).toBeNull();
});

test('parseUsername', () => {
  expect(parseUsername(' Prosta_1 ')).toEqual({ username: 'Prosta_1', usernameLower: 'prosta_1' });
  expect(parseUsername('Əli.Məmmədov')).not.toBeNull();
  expect(parseUsername('ab')).toBeNull();
  expect(parseUsername('a b c')).toBeNull();
  expect(parseUsername('_abc')).toBeNull();
  expect(parseUsername('x'.repeat(21))).toBeNull();
  expect(parseUsername('')).toBeNull();
});
