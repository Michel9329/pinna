/**
 * Pinna - email sender. A PINNA_FROM_EMAIL hardcoded in wrangler.toml on
 * someone else's domain makes Resend answer 403 for whoever installs from the
 * README. No active sender in the file, only the commented placeholder;
 * without the variable the sender is onboarding@resend.dev.
 */
import { test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendMagicEmail } from '../worker/auth';
import { sendEmail } from '../worker/notify';
import { makeEnv } from './helpers/env';

const ROOT = join(import.meta.dir, '..');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('wrangler.toml: no active PINNA_FROM_EMAIL and no email address in the active lines', () => {
  const active = readFileSync(join(ROOT, 'wrangler.toml'), 'utf-8')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'));
  expect(active.some((l) => /PINNA_FROM_EMAIL\s*=/.test(l))).toBe(false);
  // Any "@" followed by a host character counts: no sender address on any
  // domain may sit in the active configuration.
  expect(active.some((l) => /@[\w.-]/.test(l))).toBe(false);
});

test('without PINNA_FROM_EMAIL the sender is onboarding@resend.dev (sign-in and notifications)', async () => {
  const from: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    from.push(JSON.parse(String(init?.body || '{}')).from);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  await sendMagicEmail('c@example.com', 'https://pinna.test/api/auth/verify?token=t', '123456', null, env);
  await sendEmail(env, 'c@example.com', 'subject', '<p>x</p>');
  expect(from).toEqual(['Pinna <onboarding@resend.dev>', 'Pinna <onboarding@resend.dev>']);
});
