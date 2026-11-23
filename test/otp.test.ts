/**
 * Pinna - atomic cap on OTP attempts. Without it, N parallel requests all read
 * attempts=0 and all compared: the cap of 5 was bypassed by firing the
 * attempts in parallel.
 */
import { test, expect } from 'bun:test';
import * as db from '../worker/db';
import { makeD1 } from './helpers/env';

async function seedLink(DB: D1Database, email: string, code: string): Promise<void> {
  await db.createMagicLink(DB, email, 'hash-' + code + '-' + Math.random(), code);
}

test('10 parallel attempts: only 5 are compared, the right code as the 8th does not get in', async () => {
  const { DB } = makeD1();
  await seedLink(DB, 'a@example.com', '123456');
  const guesses = ['000001', '000002', '000003', '000004', '000005', '000006', '000007', '123456', '000009', '000010'];
  const results = await Promise.all(guesses.map((g) => db.verifyOtp(DB, 'a@example.com', g)));
  expect(results.filter(Boolean)).toEqual([]);
  // The code is disabled: even the right one no longer works (the link does, see login-lockout).
  expect(await db.verifyOtp(DB, 'a@example.com', '123456')).toBeNull();
});

test('right code within the 5 attempts: signs in, and the link cannot be reused', async () => {
  const { DB } = makeD1();
  await seedLink(DB, 'b@example.com', '654321');
  expect(await db.verifyOtp(DB, 'b@example.com', '111111')).toBeNull();
  expect(await db.verifyOtp(DB, 'b@example.com', '222222')).toBeNull();
  expect(await db.verifyOtp(DB, 'b@example.com', '654321')).toBe('b@example.com');
  expect(await db.verifyOtp(DB, 'b@example.com', '654321')).toBeNull();
});

test('after 5 errors the sixth attempt (even the right one) fails', async () => {
  const { DB } = makeD1();
  await seedLink(DB, 'c@example.com', '999999');
  for (let i = 0; i < 5; i++) expect(await db.verifyOtp(DB, 'c@example.com', '00000' + i)).toBeNull();
  expect(await db.verifyOtp(DB, 'c@example.com', '999999')).toBeNull();
});
