/**
 * Pinna - auth primitive tests.
 * Run: `bun test` from the repository root.
 *
 * Locks down the integrity of widget tokens and session cookies: the HMAC
 * signature must round-trip and any tampering (body, signature, secret) must
 * give null. Pure functions (crypto.subtle is available in bun) -> no
 * Miniflare/DB.
 */
import { test, expect } from 'bun:test';
import { signToken, verifyToken, safeEqual, isAdminEmail } from '../worker/auth';

const SECRET = 'test-secret-abc-123';

test('signToken/verifyToken round-trip returns the payload', async () => {
  const payload = { uid: 'u_1', pid: 'p_1', exp: 1799999999999 };
  const token = await signToken(payload, SECRET);
  const back = await verifyToken<typeof payload>(token, SECRET);
  expect(back).toEqual(payload);
});

test('verifyToken with the WRONG secret -> null', async () => {
  const token = await signToken({ uid: 'u_1' }, SECRET);
  expect(await verifyToken(token, 'other-secret')).toBeNull();
});

test('verifyToken with a tampered BODY -> null', async () => {
  const token = await signToken({ uid: 'u_1', role: 'client' }, SECRET);
  const [, sig] = token.split('.');
  // different body, old signature
  const forgedBody = Buffer.from(JSON.stringify({ uid: 'u_1', role: 'admin' }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  expect(await verifyToken(`${forgedBody}.${sig}`, SECRET)).toBeNull();
});

test('verifyToken with a tampered SIGNATURE -> null', async () => {
  const token = await signToken({ uid: 'u_1' }, SECRET);
  const [body] = token.split('.');
  expect(await verifyToken(`${body}.deadbeef`, SECRET)).toBeNull();
});

test('verifyToken malformed (no dot) -> null', async () => {
  expect(await verifyToken('nondotseparated', SECRET)).toBeNull();
  expect(await verifyToken('', SECRET)).toBeNull();
});

test('safeEqual: equal true, different/different lengths false', () => {
  expect(safeEqual('abc', 'abc')).toBe(true);
  expect(safeEqual('abc', 'abd')).toBe(false);
  expect(safeEqual('abc', 'abcd')).toBe(false);
  expect(safeEqual('', '')).toBe(true);
});

test('isAdminEmail: case-insensitive match + trim, miss otherwise', () => {
  const env = { ADMIN_EMAILS: 'admin@example.com, collab@example.com' } as unknown as Parameters<
    typeof isAdminEmail
  >[1];
  expect(isAdminEmail('admin@example.com', env)).toBe(true);
  expect(isAdminEmail('  COLLAB@EXAMPLE.COM ', env)).toBe(true);
  expect(isAdminEmail('stranger@example.com', env)).toBe(false);
  expect(isAdminEmail('', env)).toBe(false);
});

test('isAdminEmail: ADMIN_EMAILS empty/absent -> always false (inert feature flag)', () => {
  const empty = { ADMIN_EMAILS: '' } as unknown as Parameters<typeof isAdminEmail>[1];
  const undef = {} as unknown as Parameters<typeof isAdminEmail>[1];
  expect(isAdminEmail('admin@example.com', empty)).toBe(false);
  expect(isAdminEmail('admin@example.com', undef)).toBe(false);
});
