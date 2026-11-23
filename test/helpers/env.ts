/**
 * Pinna - fake environment for the tests.
 *
 * D1 simulated with in-memory bun:sqlite, with the REAL migrations applied
 * (migrations/*.sql in order): the tests exercise the real queries of db.ts
 * and the schema that goes to production. KV, R2, ASSETS and ExecutionContext
 * are minimal fakes, just enough to call the Worker's app.fetch().
 */
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../worker/types';
import { setResolver } from '../../worker/dns-guard';

/**
 * Fake DNS for the tests (dns-guard.ts): every name resolves to a public
 * address, no network. The DNS tests install their own resolver and then
 * put this one back.
 */
export const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];
setResolver(publicResolver);

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');

class Stmt {
  constructor(private db: Database, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, args);
  }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const row = this.db.query(this.sql).get(...(this.args as never[])) as Record<string, unknown> | null;
    if (row == null) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const results = this.db.query(this.sql).all(...(this.args as never[])) as T[];
    return { results, success: true, meta: {} };
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.db.query(this.sql).run(...(this.args as never[]));
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
}

/**
 * Test admin: the migrations create no user, so the test admin is created
 * here (makeD1), with its email in ADMIN_EMAILS (makeEnv).
 */
export const TEST_ADMIN_EMAIL = 'admin@test.local';
/** The emails the tests use for admins (seedUser with role 'admin'). */
export const TEST_ADMIN_EMAILS = [TEST_ADMIN_EMAIL, 'admin@example.com', 'm@example.com'].join(', ');

/** Minimal D1Database on top of bun:sqlite. `bare`: migrations only, no user. */
export function makeD1(opts: { skipMigrations?: string[]; bare?: boolean } = {}): { DB: D1Database; raw: Database } {
  const raw = new Database(':memory:');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (opts.skipMigrations?.some((s) => f.includes(s))) continue;
    raw.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  if (!opts.bare) {
    raw.query('INSERT INTO users (id, email, role, name, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'u_admin', TEST_ADMIN_EMAIL, 'admin', 'Admin', Date.now(),
    );
  }
  const DB = {
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
  return { DB, raw };
}

/** In-memory fake KV (only the get/put/delete used by the rate limits). */
export function makeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v);
    },
    delete: async (k: string) => {
      m.delete(k);
    },
  } as unknown as KVNamespace;
}

/** In-memory fake R2. */
export function makeR2(): R2Bucket & { keys: () => string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k: string, v: unknown) => {
      m.set(k, v instanceof Uint8Array ? v : new Uint8Array(await new Response(v as BodyInit).arrayBuffer()));
      return {};
    },
    get: async (k: string) => {
      const v = m.get(k);
      return v ? { body: new Response(v).body } : null;
    },
    delete: async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) m.delete(key);
    },
    keys: () => [...m.keys()],
  } as unknown as R2Bucket & { keys: () => string[] };
}

// At least 32 characters (MIN_SECRET_LEN in worker/config.ts).
export const TEST_SECRET = 'test-secret-for-pinna-tests-that-is-long-enough';

export function makeEnv(over: Partial<Env> = {}): Env & { raw: Database } {
  const { DB, raw } = makeD1();
  return {
    DB,
    raw,
    ASSETS: {
      fetch: async () => new Response('<!doctype html><title>Pinna</title>', { headers: { 'Content-Type': 'text/html' } }),
    } as unknown as Fetcher,
    SESSION_SECRET: TEST_SECRET,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    ATTACHMENTS: makeR2(),
    RATE_LIMIT: makeKV(),
    ...over,
  } as Env & { raw: Database };
}

/** Fake ExecutionContext: collects the waitUntil promises. */
export function makeCtx(): ExecutionContext & { settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p.catch(() => {}));
    },
    passThroughOnException: () => {},
    settle: async () => {
      await Promise.all(pending);
    },
  } as unknown as ExecutionContext & { settle: () => Promise<void> };
}

/** Inserts a user and returns its id. */
export function seedUser(raw: Database, id: string, email: string, role: string, name: string | null = null): string {
  raw.query('INSERT OR REPLACE INTO users (id, email, role, name, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, email, role, name, Date.now(),
  );
  return id;
}

export function seedProject(raw: Database, id: string, slug: string, stagingUrl: string): string {
  raw.query('INSERT INTO projects (id, name, slug, staging_url, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, 'Project ' + slug, slug, stagingUrl, Date.now(),
  );
  return id;
}

/**
 * The same request with Content-Length: uploads and /shot require it, and
 * Bun's Request does not set it by itself. The headers are read BEFORE the
 * body (the multipart boundary must stay the same).
 */
export async function sized(req: Request): Promise<Request> {
  // GET/HEAD have no body: left as they are (every body requires
  // Content-Length, and the tests send everything through here).
  if (req.method === 'GET' || req.method === 'HEAD' || req.headers.has('content-length')) return req;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const buf = await req.arrayBuffer();
  headers['content-length'] = String(buf.byteLength);
  return new Request(req.url, { method: req.method, headers, body: buf });
}

/**
 * app.fetch with Content-Length set the way a browser does (the JSON routes
 * and the forms require it, Bun's Request does not set it).
 */
export async function appFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { default: app } = await import('../../worker/index');
  return app.fetch(await sized(req), env, ctx);
}
