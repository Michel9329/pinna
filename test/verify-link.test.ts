/**
 * Pinna - the email link is not consumed by a GET. Mail scanners (Microsoft
 * 365 Safe Links) open the link first: with a GET that consumed it, the client
 * would find "link expired". The GET shows a button, the POST (from the same
 * origin only) signs in.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { sha256hex } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
const TOKEN = 'tok-' + 'a'.repeat(40);

async function setup(): Promise<Env> {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  env.raw
    .query('INSERT INTO magic_links (token_hash, email, expires_at, used_at, code, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
    .run(await sha256hex(TOKEN), 'c@example.com', Date.now() + 600_000, '111111', Date.now());
  return env;
}

async function call(env: Env, req: Request) {
  const ctx = makeCtx();
  const res = await appFetch(req, env, ctx);
  await ctx.settle();
  return res;
}

const used = (env: Env) =>
  (env.raw.query('SELECT used_at FROM magic_links').get() as { used_at: number | null }).used_at;

function postVerify(origin: string | null) {
  return new Request('https://pinna.test/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) },
    body: 'token=' + encodeURIComponent(TOKEN),
  });
}

test('GET of the link: a page with a button, the link is NOT consumed (even when opened twice)', async () => {
  const env = await setup();
  for (let i = 0; i < 2; i++) {
    const res = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const html = await res.text();
    expect(html).toContain('<form method="POST" action="/api/auth/verify">');
    expect(html).toContain('value="' + TOKEN + '"');
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
  }
  expect(used(env)).toBeNull();
});

test('POST from the same origin: signs in, link consumed, 303 redirect', async () => {
  const env = await setup();
  const res = await call(env, postVerify('https://pinna.test'));
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toBe('https://pinna.test/');
  expect(res.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
  expect(used(env)).not.toBeNull();
  // Second submit: the link is already used.
  const again = await call(env, postVerify('https://pinna.test'));
  expect(again.headers.get('Location')).toContain('/login?err=expired');
});

test('POST from another site (login CSRF): refused, link intact', async () => {
  const env = await setup();
  const res = await call(env, postVerify('https://evil.test'));
  expect(res.status).toBe(403);
  expect(res.headers.get('Set-Cookie')).toBeNull();
  expect(used(env)).toBeNull();
});

test('a token that breaks the HTML: escaped in the page', async () => {
  const env = await setup();
  // A valid link row for this token, so the page is rendered with it.
  const bad = '"><script>x</script>';
  env.raw
    .query('INSERT INTO magic_links (token_hash, email, expires_at, used_at, code, created_at) VALUES (?, ?, ?, NULL, NULL, ?)')
    .run(await sha256hex(bad), 'c@example.com', Date.now() + 600_000, Date.now());
  const res = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + encodeURIComponent(bad)));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain('<script>x');
  expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
});

test('the link page names the account, masked, without consuming the link', async () => {
  const env = await setup();
  const res = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + TOKEN));
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<b>c***@example.com</b>');
  expect(html).not.toContain('c@example.com');
  expect(used(env)).toBeNull();
});

test('the masked account is escaped', async () => {
  const env = await setup();
  const tok = 'tok-' + 'b'.repeat(40);
  env.raw
    .query('INSERT INTO magic_links (token_hash, email, expires_at, used_at, code, created_at) VALUES (?, ?, ?, NULL, NULL, ?)')
    .run(await sha256hex(tok), '<x@ex<b>ample.com', Date.now() + 600_000, Date.now());
  const html = await (await call(env, new Request('https://pinna.test/api/auth/verify?token=' + tok))).text();
  expect(html).toContain('<b>&lt;***@ex&lt;b&gt;ample.com</b>');
  expect(html).not.toContain('ex<b>ample');
});

test('unknown, used or expired token: the error path of a failed sign-in, no page', async () => {
  const env = await setup();
  const unknown = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + 'z'.repeat(44)));
  expect(unknown.status).toBe(302);
  expect(unknown.headers.get('Location')).toBe('https://pinna.test/login?err=expired');
  env.raw.query('UPDATE magic_links SET expires_at = ?').run(Date.now() - 1);
  const expired = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + TOKEN));
  expect(expired.status).toBe(302);
  expect(expired.headers.get('Location')).toBe('https://pinna.test/login?err=expired');
  env.raw.query('UPDATE magic_links SET expires_at = ?, used_at = ?').run(Date.now() + 600_000, Date.now());
  const usedLink = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + TOKEN));
  expect(usedLink.headers.get('Location')).toBe('https://pinna.test/login?err=expired');
});

/**
 * With meta referrer no-referrer on the page, browsers send the button's POST
 * with `Origin: null` (Chromium, Firefox and WebKit send Origin=null and
 * Sec-Fetch-Site=same-origin): 403, nobody could sign in.
 */
function postVerifyHeaders(h: Record<string, string>) {
  return new Request('https://pinna.test/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...h },
    body: 'token=' + encodeURIComponent(TOKEN),
  });
}

test('link page: same-origin referrer, in the meta and in the header', async () => {
  const env = await setup();
  const res = await call(env, new Request('https://pinna.test/api/auth/verify?token=' + TOKEN));
  const html = await res.text();
  expect(html).toContain('<meta name="referrer" content="same-origin">');
  expect(html).not.toContain('no-referrer');
  expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
});

test('Origin null with Sec-Fetch-Site same-origin (what browsers send): signs in', async () => {
  const env = await setup();
  const res = await call(env, postVerifyHeaders({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }));
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toBe('https://pinna.test/');
  expect(res.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
  expect(used(env)).not.toBeNull();
});

test('Origin null alone, or with a Sec-Fetch-Site from another site: refused, link intact', async () => {
  for (const h of [
    { Origin: 'null' },
    { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'null', 'Sec-Fetch-Site': 'same-site' },
    { Origin: 'null', 'Sec-Fetch-Site': 'none' },
  ]) {
    const env = await setup();
    const res = await call(env, postVerifyHeaders(h));
    expect(res.status).toBe(403);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(used(env)).toBeNull();
  }
});

test('Origin of another site with a fake same-origin Sec-Fetch-Site: Origin decides, refused', async () => {
  const env = await setup();
  const res = await call(env, postVerifyHeaders({ Origin: 'https://evil.test', 'Sec-Fetch-Site': 'same-origin' }));
  expect(res.status).toBe(403);
  expect(used(env)).toBeNull();
});
