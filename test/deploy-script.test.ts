/**
 * Pinna - the deploy script applies the migrations before the Worker: if
 * `bun run deploy` only ran build + wrangler deploy, the migrations would
 * stay a manual step.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>;
};

test('deploy: remote migrations, then build, then wrangler deploy, chained with &&', () => {
  const steps = pkg.scripts.deploy!.split('&&').map((x) => x.trim());
  expect(steps[0]).toBe('wrangler d1 migrations apply pinna --remote');
  expect(steps.indexOf('node scripts/build.mjs')).toBeGreaterThan(0);
  expect(steps[steps.length - 1]).toBe('wrangler deploy');
  // The migrations database is the Worker's one.
  const toml = readFileSync(join(import.meta.dir, '..', 'wrangler.toml'), 'utf-8');
  expect(toml).toContain('database_name = "pinna"');
});

test('development: wrangler dev listens on 127.0.0.1 only (dev mode trusts the host)', () => {
  // With --local-upstream the host is always localhost: without binding the
  // interface, anyone on the local network would get in through dev mode.
  expect(pkg.scripts.dev).toContain('--ip 127.0.0.1');
  expect(pkg.scripts.dev).toContain('--local-upstream localhost:8787');
  // The real lines of wrangler.toml, without comments.
  const lines = readFileSync(join(import.meta.dir, '..', 'wrangler.toml'), 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const dev = lines.indexOf('[dev]');
  expect(dev).toBeGreaterThanOrEqual(0);
  expect(lines[dev + 1]).toBe('ip = "127.0.0.1"');
  expect(lines.some((l) => l.includes('0.0.0.0'))).toBe(false);
});

/**
 * When a value that was a plain variable in wrangler.toml becomes a secret, a
 * plain deploy removes the variable before the secret exists, and the Worker
 * runs for a while without it (for PINNA_FROM_EMAIL that means the default
 * sender). `deploy:secrets` uploads the secrets in the same version as the
 * code, with --secrets-file.
 */
test('deploy:secrets: same steps as deploy, secrets uploaded with the version', () => {
  const steps = pkg.scripts['deploy:secrets']!.split('&&').map((x) => x.trim());
  const plain = pkg.scripts.deploy!.split('&&').map((x) => x.trim());
  expect(steps.slice(0, -1)).toEqual(plain.slice(0, -1));
  expect(steps[steps.length - 1]).toBe('wrangler deploy --secrets-file .deploy-secrets.env');
  // The secrets file is never committed.
  const ignore = readFileSync(join(import.meta.dir, '..', '.gitignore'), 'utf-8').split(/\r?\n/).map((l) => l.trim());
  expect(ignore).toContain('.deploy-secrets.env');
});

test('README: deploying updates, migrations first and secrets in the same version', () => {
  const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf-8');
  const at = readme.indexOf('## Deploying updates');
  expect(at).toBeGreaterThan(0);
  const end = readme.indexOf('\n## ', at + 1);
  const section = readme.slice(at, end > at ? end : undefined);
  expect(section).toContain('wrangler d1 migrations apply pinna --remote && node scripts/build.mjs && wrangler deploy');
  expect(section).toContain('bun run deploy:secrets');
  expect(section).toContain('.deploy-secrets.env');
  // The old advice (secret put before the deploy) must not come back: no code
  // block of this section runs `wrangler secret put PINNA_FROM_EMAIL`
  // (`wrangler versions secret put` is a different command).
  const code = section.split(/^\s*```.*$/m).filter((_, i) => i % 2 === 1).join('\n');
  expect(code).not.toMatch(/^\s*(bunx\s+|npx\s+)?wrangler\s+secret\s+put\s+PINNA_FROM_EMAIL\b/m);
});

test('README Setup: creates D1, KV and R2 and says where the ids go; no workers.dev in the widget', () => {
  const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf-8');
  const setup = readme.slice(readme.indexOf('## Setup'), readme.indexOf('### Configuration'));
  expect(setup).toContain('wrangler d1 create');
  expect(setup).toContain('wrangler kv namespace create RATE_LIMIT');
  expect(setup).toContain('wrangler r2 bucket create');
  expect(readme).toContain('[[kv_namespaces]]');
  expect(readme).toContain('[[r2_buckets]]');
  // workers_dev = false: a data-pinna-api on *.workers.dev does not answer.
  expect(readme).not.toMatch(/data-pinna-api="[^"]*workers\.dev/);
  const toml = readFileSync(join(import.meta.dir, '..', 'wrangler.toml'), 'utf-8');
  expect(toml).toMatch(/^workers_dev = false/m);
});
