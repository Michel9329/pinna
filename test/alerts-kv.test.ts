/**
 * Pinna - KV writes of the alerts. Without a cap every failed /shot (and every
 * 5xx) would write the counter to KV, and the free plan allows 1,000 writes a
 * day. The counter stops at COUNTER_CAP.
 */
import { test, expect, afterEach } from 'bun:test';
import { recordError, sendErrorDigest, COUNTER_CAP } from '../worker/alerts';
import { makeEnv } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** In-memory KV that counts the writes per key. */
function countingKV() {
  const m = new Map<string, string>();
  const puts = new Map<string, number>();
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v);
      puts.set(k, (puts.get(k) ?? 0) + 1);
    },
    delete: async (k: string) => {
      m.delete(k);
    },
  } as unknown as KVNamespace;
  return { kv, puts, total: () => [...puts.values()].reduce((a, b) => a + b, 0) };
}

test('500 failed /shot: at most COUNTER_CAP counter writes and one alert', async () => {
  const sent: string[] = [];
  const html: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body || '{}'));
    sent.push(b.subject);
    html.push(b.html);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const { kv, puts, total } = countingKV();
  const env = makeEnv({ RATE_LIMIT: kv, ALERT_EMAIL: 'ops@example.com', RESEND_API_KEY: 're_test' });
  for (let i = 0; i < 500; i++) await recordError(env, 'shot');
  expect(puts.get('err:shot')).toBe(COUNTER_CAP);
  expect(total()).toBe(COUNTER_CAP + 1); // + the alert cooldown
  expect(sent.filter((s) => s.includes('"shot"')).length).toBe(1);
  // The digest says the counter is saturated.
  await sendErrorDigest(env);
  const i = sent.findIndex((s) => s.includes('digest'));
  expect(i).toBeGreaterThan(-1);
  expect(html[i]).toContain('shot: ' + COUNTER_CAP + '+');
});

test('without ALERT_EMAIL: only the counter, stopped at COUNTER_CAP', async () => {
  const { kv, total } = countingKV();
  const env = makeEnv({ RATE_LIMIT: kv });
  for (let i = 0; i < 300; i++) await recordError(env, 'unhandled');
  expect(total()).toBe(COUNTER_CAP);
});
