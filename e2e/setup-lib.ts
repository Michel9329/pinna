/**
 * Pinna - e2e, the pieces of the globalSetup.
 *
 * Starts locally everything the browser tests need, without touching anything
 * remote: local D1 and R2 in a temporary folder (--persist-to), the real
 * migrations, made-up sample data, `wrangler dev` on 127.0.0.1 with dev mode
 * on (link and code in the /auth/request response) and a sample site on
 * another origin that loads the widget. All over https with a throwaway
 * certificate (openssl): Pinna's cookies are __Host- and Secure, and WebKit
 * does not keep them on http://localhost (sign-in succeeds, the cookie is
 * dropped, back to the sign-in page). At the end it closes ONLY the processes
 * started here (the wrangler tree, by PID) and deletes ONLY the temporary
 * folder created here.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, BROWSERS, PROJECT, seedSql } from './data';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** A free TCP port on 127.0.0.1 (asked from the system). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function newestMtime(dir: string): number {
  let max = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    max = Math.max(max, name.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return max;
}

/**
 * Builds the app and the widget (app/dist) if missing or older than the
 * sources: the Worker serves the SPA and pinna.js from there.
 * PINNA_E2E_SKIP_BUILD=1 skips it.
 */
export function ensureBuild(): void {
  if (process.env.PINNA_E2E_SKIP_BUILD === '1') return;
  const dist = join(ROOT, 'app', 'dist');
  const index = join(dist, 'index.html');
  const widget = join(dist, 'pinna.js');
  const stale =
    !existsSync(index) ||
    !existsSync(widget) ||
    statSync(join(ROOT, 'widget', 'pinna.js')).mtimeMs > statSync(widget).mtimeMs ||
    newestMtime(join(ROOT, 'app', 'src')) > statSync(index).mtimeMs;
  if (!stale) return;
  if (!existsSync(join(ROOT, 'app', 'node_modules'))) {
    throw new Error('[e2e] app/node_modules is missing: run `bun install` inside app/, then try again');
  }
  console.log('[e2e] building the app and the widget (scripts/build.mjs)...');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('[e2e] build failed');
}

/**
 * Environment of the wrangler processes: no RESEND_API_KEY (no real email can
 * go out), no environment variables in the bindings, metrics off.
 */
function wranglerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'RESEND_API_KEY' || k.startsWith('PINNA_') || k === 'CLOUDFLARE_API_TOKEN' || k === 'CLOUDFLARE_ACCOUNT_ID') delete env[k];
  }
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'true';
  env.WRANGLER_SEND_METRICS = 'false';
  env.CI = '1'; // no interactive prompts (migrations apply)
  env.NO_COLOR = '1';
  return env;
}

function runWrangler(args: string[], label: string): void {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env: wranglerEnv(),
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error('[e2e] ' + label + ' failed:\n' + (r.stdout || '') + (r.stderr || ''));
  }
}

/** openssl to use: PINNA_E2E_OPENSSL, then the PATH, then the one shipped with Git for Windows. */
function opensslBin(): string {
  const cands = [process.env.PINNA_E2E_OPENSSL || '', 'openssl'];
  if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')];
    for (const base of bases) {
      if (!base) continue;
      cands.push(join(base, 'Git', 'usr', 'bin', 'openssl.exe'), join(base, 'Git', 'mingw64', 'bin', 'openssl.exe'));
    }
  }
  for (const c of cands) {
    if (!c) continue;
    const r = spawnSync(c, ['version'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  throw new Error('[e2e] openssl is needed (test https certificate): install it or set its path in PINNA_E2E_OPENSSL');
}

/** Throwaway certificate for localhost and 127.0.0.1, valid for 2 days, in the temporary folder. */
export function makeCert(dir: string): { keyPath: string; certPath: string; key: string; cert: string } {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const r = spawnSync(
    opensslBin(),
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0 || !existsSync(certPath)) throw new Error('[e2e] certificate not created:\n' + (r.stderr || ''));
  return { keyPath, certPath, key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') };
}

/** Sample site: another origin (127.0.0.1) that loads pinna.js from Pinna (localhost). */
export function startSite(pinnaBase: string, tls: { key: string; cert: string }): Promise<{ server: Server; origin: string }> {
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Acme Test Site</title>',
    '<style>body{margin:0;font-family:system-ui,sans-serif;color:#1e293b}',
    'header{padding:48px 64px;background:#f1f5f9}main{padding:48px 64px;min-height:900px}',
    'h1{margin:0;font-size:40px}p{max-width:60ch;line-height:1.6}</style></head><body>',
    '<header><h1 id="title">Acme Test Site</h1></header>',
    '<main><h2>About us</h2><p id="text">Sample site for the Pinna tests: ',
    'no real data, no requests to the outside.</p>',
    '<h2>Contact</h2><p>1 Example Street, Testville.</p></main>',
    '<script src="', pinnaBase, '/pinna.js" defer></script>',
    '</body></html>',
  ].join('');
  const server = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const path = new URL(req.url || '/', 'https://x').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: server as unknown as Server, origin: 'https://127.0.0.1:' + port });
    });
  });
}

/** Closes the process tree we started (by PID, never by name or port). */
export async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM'); // group: started detached
    } catch {
      child.kill('SIGTERM');
    }
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
}

/** https GET trusting ONLY the test certificate (no NODE_TLS_REJECT_UNAUTHORIZED). */
function getStatus(url: string, ca: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { method: 'GET', ca, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

async function waitHealthy(base: string, ca: string, child: ChildProcess, logPath: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('[e2e] wrangler dev exited right away, see ' + logPath);
    if ((await getStatus(base + '/api/health', ca)) === 200) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('[e2e] wrangler dev does not answer on ' + base + ', see ' + logPath);
}

export interface Running {
  base: string;
  site: string;
  tmp: string;
  stop: () => Promise<void>;
}

export async function startAll(): Promise<Running> {
  ensureBuild();
  const tmp = mkdtempSync(join(tmpdir(), 'pinna-e2e-'));
  const state = join(tmp, 'state');
  let child: ChildProcess | null = null;
  let site: Server | null = null;
  let log: WriteStream | null = null;
  const stop = async () => {
    if (site) await new Promise<void>((r) => site!.close(() => r()));
    site = null;
    if (child) {
      const pid = child.pid;
      await killTree(child);
      console.log('[e2e] wrangler dev closed (PID ' + pid + ')');
    }
    child = null;
    // The open log file would lock the folder on Windows (EPERM).
    if (log) await new Promise<void>((r) => log!.end(() => r()));
    log = null;
    if (process.env.PINNA_E2E_KEEP === '1') {
      console.log('[e2e] temporary folder kept (PINNA_E2E_KEEP=1):', tmp);
      return;
    }
    // Only the temporary folder created here. On Windows the wrangler children
    // (workerd) release the files a few seconds after taskkill: retry.
    const until = Date.now() + 30_000;
    for (;;) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        break;
      } catch (e) {
        if (Date.now() > until) {
          console.warn('[e2e] temporary folder not deleted:', tmp, (e as Error).message);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  try {
    const port = await freePort();
    const inspector = await freePort();
    const base = 'https://localhost:' + port;
    const tls = makeCert(tmp);
    const s = await startSite(base, tls);
    site = s.server;

    runWrangler(['d1', 'migrations', 'apply', 'pinna', '--local', '--persist-to', state], 'migrations apply');
    const seedPath = join(tmp, 'seed.sql');
    writeFileSync(seedPath, seedSql(s.origin), 'utf-8');
    runWrangler(['d1', 'execute', 'pinna', '--local', '--persist-to', state, '--file', seedPath], 'seed');

    // Variables of the test instance in an .env file: with --env-file wrangler
    // does NOT read .dev.vars (which on another machine could hold a real
    // RESEND_API_KEY). All values are made up.
    const envFile = join(tmp, 'e2e.env');
    writeFileSync(
      envFile,
      [
        'SESSION_SECRET=' + ADMIN.sessionSecret,
        'ADMIN_KEY=' + ADMIN.key,
        'ADMIN_EMAILS=' + ADMIN.email,
        'PINNA_DEV_MODE=1',
        '',
      ].join('\n'),
      'utf-8',
    );
    const logPath = join(tmp, 'wrangler-dev.log');
    log = createWriteStream(logPath);
    child = spawn(
      process.execPath,
      [
        WRANGLER, 'dev',
        '--ip', '127.0.0.1',
        '--port', String(port),
        '--local-upstream', 'localhost:' + port,
        '--local-protocol', 'https',
        '--https-key-path', tls.keyPath,
        '--https-cert-path', tls.certPath,
        '--inspector-port', String(inspector),
        '--persist-to', state,
        '--env-file', envFile,
        '--show-interactive-dev-session=false',
      ],
      { cwd: ROOT, env: wranglerEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
    );
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    console.log('[e2e] wrangler dev started (PID ' + child.pid + ') on ' + base + ', sample site ' + s.origin);
    await waitHealthy(base, tls.cert, child, logPath);
    return { base, site: s.origin, tmp, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

export { BROWSERS, PROJECT };
