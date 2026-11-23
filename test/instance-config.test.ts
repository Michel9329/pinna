/**
 * Pinna - instance configuration: the alert recipient and the public address
 * come from the variables, and no instance address is hard-coded in the code
 * (alerts.ts, notify.ts, auth.ts, widget, app).
 */
import { test, expect, afterEach } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { publicOrigin, alertRecipient } from '../worker/config';
import { recordError, sendErrorDigest } from '../worker/alerts';
import { magicEmailHtml } from '../worker/auth';
import { notifyHtml } from '../worker/notify';
import { makeEnv } from './helpers/env';

const ROOT = join(import.meta.dir, '..');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Intercepts the calls to Resend and returns their recipients. */
function captureResend(): string[] {
  const to: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    to.push(JSON.parse(String(init?.body || '{}')).to);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return to;
}

test('publicOrigin: PINNA_PUBLIC_URL wins, otherwise the request origin', () => {
  expect(publicOrigin(makeEnv({ PINNA_PUBLIC_URL: 'https://review.example.org/x/' }), 'https://other.test/a')).toBe('https://review.example.org');
  expect(publicOrigin(makeEnv(), 'https://pinna.test/api/auth/request')).toBe('https://pinna.test');
  expect(publicOrigin(makeEnv({ PINNA_PUBLIC_URL: 'not a url' }), 'https://pinna.test/a')).toBe('https://pinna.test');
  expect(publicOrigin(makeEnv({ PINNA_PUBLIC_URL: 'javascript:alert(1)' }), 'https://pinna.test/a')).toBe('https://pinna.test');
  expect(publicOrigin(makeEnv())).toBe('');
});

test('alerts: without ALERT_EMAIL no email is sent (no built-in fallback recipient)', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  expect(alertRecipient(env)).toBeNull();
  for (let i = 0; i < 5; i++) await recordError(env, 'shot');
  await sendErrorDigest(env);
  expect(to).toEqual([]);
});

test('alerts: with ALERT_EMAIL the alert and the digest go only there', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test', ALERT_EMAIL: 'ops@example.org' });
  for (let i = 0; i < 3; i++) await recordError(env, 'shot');
  await sendErrorDigest(env);
  expect(to).toEqual(['ops@example.org', 'ops@example.org']);
});

test('sign-in and notification emails: logo from the same origin as the link', () => {
  const magic = magicEmailHtml('https://review.example.org/api/auth/verify?token=t', '123456', null);
  expect(magic).toContain('src="https://review.example.org/pinna-wordmark-email.png"');
  const notif = notifyHtml(null, 'Site', 'Line', 'Text', 'https://review.example.org/p/site');
  expect(notif).toContain('src="https://review.example.org/pinna-wordmark-email.png"');
});

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|js|vue)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Rule: every address in the code (code, comments and markup alike) must be a
 * placeholder or a third-party service, never the address of a real instance.
 * An "address" is a URL host (any scheme), an email domain, or a quoted bare
 * hostname on a public TLD (e.g. '.my-instance.com' in an origin check).
 * Allowed:
 * - reserved names (RFC 2606 / RFC 6761): example.com/.net/.org and their
 *   subdomains, *.example, *.test, *.invalid, *.localhost, localhost, IP literals;
 * - third-party services the code calls: api.resend.com (email API),
 *   resend.dev (Resend's shared test sender), cloudflare-dns.com (DNS over HTTPS);
 * - documentation values: cdn.sanity.io and cdn.shopify.com (sample asset
 *   origins for PINNA_SHOT_ASSET_ORIGINS), www.w3.org (SVG namespace).
 * A new third-party host the code legitimately calls goes in THIRD_PARTY.
 */
const THIRD_PARTY = ['api.resend.com', 'resend.dev', 'cloudflare-dns.com', 'cdn.sanity.io', 'cdn.shopify.com', 'www.w3.org'];

function allowedHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/\.$/, '');
  if (THIRD_PARTY.includes(host)) return true;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/.test(host)) return true;
  return /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/.test(host);
}

const ADDRESS_PATTERNS = [
  // URL host: scheme://host (a host starts with a letter, a digit or "[").
  /\b[a-z][a-z0-9+.-]*:\/\/(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]*)/gi,
  // Email domain: local@domain.tld
  /[a-z0-9._%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})/gi,
  // Quoted bare hostname on a public TLD: 'host.tld' or '.host.tld'
  /['"`]\.?((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|me|it|es|eu|de|fr|uk|ch|info|biz|cloud|studio|site))['"`]/gi,
];

test('no instance address hard-coded in the code (worker, widget, app)', () => {
  const files = [...sources(join(ROOT, 'worker')), join(ROOT, 'widget', 'pinna.js'), ...sources(join(ROOT, 'app', 'src'))];
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf-8');
    for (const re of ADDRESS_PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (!allowedHost(m[1]!)) hits.push(f.slice(ROOT.length + 1) + ': ' + m[0]);
      }
    }
  }
  expect(hits).toEqual([]);
});
