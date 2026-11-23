/**
 * Pinna - /entra without the key in the query: the bookmark is
 * /entra#k=<key> (the fragment never reaches the server), the page sends it
 * in a POST. Minimum length of SESSION_SECRET and ADMIN_KEY.
 */
import { test, expect } from 'bun:test';
import vm from 'node:vm';
import app from '../worker/index';
import { MIN_SECRET_LEN } from '../worker/config';
import { appFetch, makeEnv, makeCtx } from './helpers/env';

const KEY = 'admin-key-that-is-long-enough-for-tests';

async function call(env: ReturnType<typeof makeEnv>, req: Request) {
  const ctx = makeCtx();
  const res = await appFetch(req, env, ctx);
  await ctx.settle();
  return res;
}
const auditRows = (env: ReturnType<typeof makeEnv>) =>
  (env.raw.query('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n;

test('GET /entra?k=<right key>: does not sign in, no cookie, no check', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY });
  const res = await call(env, new Request('https://pinna.test/entra?k=' + KEY));
  expect(res.status).toBe(400);
  expect(res.headers.get('Set-Cookie')).toBeNull();
  expect(await res.text()).toContain('/entra#k=');
  expect(auditRows(env)).toBe(0);
});

test('GET /entra: page that reads #k= and POSTs it, script with the CSP nonce', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY });
  const res = await call(env, new Request('https://pinna.test/entra'));
  expect(res.status).toBe(200);
  const csp = res.headers.get('Content-Security-Policy') || '';
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("form-action 'self'");
  const html = await res.text();
  expect(html).toContain('<script nonce="' + nonce + '">');
  expect(html).toContain('location.hash');
  expect(html).toContain('history.replaceState');
  expect(html).toContain('<form id="f" method="POST" action="/entra">');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
});

test('POST /entra with the key in the body: signs in', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY });
  const res = await call(
    env,
    new Request('https://pinna.test/entra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'k=' + KEY + '&goto=%2Fp%2Fsite',
    }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toBe('https://pinna.test/p/site');
  expect(res.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
});

test('ADMIN_KEY below the minimum: even the right key is not valid', async () => {
  const short = 'x'.repeat(MIN_SECRET_LEN - 1);
  const env = makeEnv({ ADMIN_KEY: short });
  const res = await call(
    env,
    new Request('https://pinna.test/entra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'k=' + short,
    }),
  );
  expect(res.headers.get('Location')).toContain('/login?err=link');
  expect((await call(env, new Request('https://pinna.test/api/summary', { headers: { 'X-Admin-Key': short } }))).status).toBe(401);
});

test('SESSION_SECRET below the minimum (or absent): API and /entra 503, assets served', async () => {
  for (const secret of ['changeme', '']) {
    const env = makeEnv({ SESSION_SECRET: secret });
    expect((await call(env, new Request('https://pinna.test/api/auth/me'))).status).toBe(503);
    expect((await call(env, new Request('https://pinna.test/entra'))).status).toBe(503);
    expect((await call(env, new Request('https://pinna.test/'))).status).toBe(200);
  }
});

async function runPageScript(hash: string) {
  const res = await call(makeEnv(), new Request('https://pinna.test/entra?goto=/p/x'));
  const js = (await res.text()).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;
  type El = { value: string; hidden: boolean; submitted?: boolean; submit?: () => void };
  const els: Record<string, El> = { k: { value: '', hidden: false }, g: { value: '', hidden: false }, m: { value: '', hidden: true }, f: { value: '', hidden: false } };
  els.f!.submit = () => {
    els.f!.submitted = true;
  };
  let shown = '';
  vm.runInNewContext(js, {
    URLSearchParams,
    location: { hash, search: '?goto=/p/x', pathname: '/entra' },
    history: { replaceState: (_a: unknown, _b: unknown, u: string) => { shown = u; } },
    document: { getElementById: (id: string) => els[id] },
  });
  return { els, shown };
}

test('the page script reads #k=, clears the address bar and submits the form', async () => {
  const { els, shown } = await runPageScript('#k=abc%2Bdef');
  expect(els.k!.value).toBe('abc+def');
  expect(els.g!.value).toBe('/p/x');
  expect(els.f!.submitted).toBe(true);
  expect(shown).toBe('/entra?goto=/p/x');
});

test('base64 key written as it is in the bookmark: the + stays +', async () => {
  const { els } = await runPageScript('#k=ab+cd/ef==');
  expect(els.k!.value).toBe('ab+cd/ef==');
});

test('without #k=: visible message, nothing submitted', async () => {
  const { els } = await runPageScript('');
  expect(els.f!.submitted).toBeUndefined();
  expect(els.m!.hidden).toBe(false);
});
