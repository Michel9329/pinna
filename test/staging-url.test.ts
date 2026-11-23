/**
 * Pinna - staging_url validated when the project is created: only http(s), no
 * credentials, no internal hosts, not even by name (127.0.0.1.nip.io).
 * Without this any string would be accepted.
 */
import { test, expect, afterEach } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { setResolver, hostVerdict, dohResolve } from '../worker/dns-guard';
import { appFetch, makeEnv, makeCtx, publicResolver, TEST_SECRET } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  setResolver(publicResolver);
  globalThis.fetch = realFetch;
});

/** Fake DNS: *.nip.io names resolve to the address they embed, everything else is public. */
function nipResolver() {
  setResolver(async (h) => {
    const m = h.match(/^(\d+\.\d+\.\d+\.\d+)\.nip\.io$/);
    return [m ? m[1]! : '93.184.216.34'];
  });
}

async function create(env: ReturnType<typeof makeEnv>, staging: string, host = 'https://pinna.test') {
  const s = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);
  const ctx = makeCtx();
  const res = await appFetch(
    new Request(host + '/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t1',
        'X-CSRF-Token': 't1',
      },
      body: JSON.stringify({ name: 'Site', staging_url: staging }),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

test('refused: non-http(s) schemes, credentials, internal hosts even by name', async () => {
  nipResolver();
  const env = makeEnv();
  for (const bad of [
    'javascript:alert(1)',
    'ftp://staging.example.org/',
    'file:///etc/passwd',
    'https://user:pw@staging.example.org/',
    'http://127.0.0.1:8080/',
    'http://localhost:4321/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'https://127.0.0.1.nip.io/',
    'https://10.1.2.3.nip.io/',
    'not a url',
  ]) {
    expect([bad, (await create(env, bad)).status]).toEqual([bad, 400]);
  }
  expect((env.raw.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
});

test('accepted: a public staging and a project without staging', async () => {
  nipResolver();
  const env = makeEnv();
  expect((await create(env, 'https://staging.example.org/')).status).toBe(201);
  expect((await create(env, '')).status).toBe(201);
});

test('dev mode on localhost: a local staging can be tried', async () => {
  const env = makeEnv({ PINNA_DEV_MODE: '1' });
  expect((await create(env, 'http://localhost:4321/', 'http://localhost:8787')).status).toBe(201);
  // Outside localhost dev mode does not kick in.
  expect((await create(env, 'http://localhost:4321/', 'https://pinna.test')).status).toBe(400);
});

test('hostVerdict: internal, public, unresolved', async () => {
  nipResolver();
  expect(await hostVerdict('127.0.0.1.nip.io')).toBe('internal');
  expect(await hostVerdict('staging.example.org')).toBe('public');
  expect(await hostVerdict('localhost')).toBe('internal');
  setResolver(async () => []);
  expect(await hostVerdict('nobody.example.org')).toBe('unresolved');
  setResolver(async () => ['93.184.216.34', '192.168.1.10']);
  expect(await hostVerdict('mixed.example.org')).toBe('internal');
});

test('dohResolve: reads A and AAAA from the cloudflare-dns.com JSON', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    asked.push(String(u));
    const aaaa = String(u).endsWith('type=AAAA');
    return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 5, data: 'alias.example.' }, { type: aaaa ? 28 : 1, data: aaaa ? '::1' : '127.0.0.1' }] }));
  }) as typeof fetch;
  expect(await dohResolve('127.0.0.1.nip.io')).toEqual(['127.0.0.1', '::1']);
  expect(asked[0]).toBe('https://cloudflare-dns.com/dns-query?name=127.0.0.1.nip.io&type=A');
});
