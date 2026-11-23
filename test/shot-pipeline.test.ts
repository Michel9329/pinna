/**
 * Pinna - the /shot handler run for real, with a fake browser in place of
 * puppeteer.launch (Browser Rendering is not available in the unit tests):
 * the caller's markup is prepared BEFORE a browser is launched, the project's
 * caps are checked inside the insert (a project that fills up while the page
 * renders refuses the screenshot and nothing is stored), and the row written
 * before the file is removed when the file cannot be stored.
 *
 * prepareShotHtml is wrapped (same output) only to note when it runs, and the
 * settle pause is 0 so a screenshot takes milliseconds. The module mock lasts
 * for the whole test process; it changes nothing for the other tests (the
 * wrapper returns the real output, and no other test reaches the pause).
 */
import { test, expect, mock, afterEach, afterAll } from 'bun:test';
import puppeteer from '@cloudflare/puppeteer';
import * as realGuard from '../worker/shot-guard';
import { signTyped } from '../worker/auth';
import { PROJECT_MAX_ATTACHMENTS, PROJECT_QUOTA_BYTES } from '../worker/upload-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
const order: string[] = [];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const guard = { ...realGuard };
mock.module('../worker/shot-guard', () => ({
  ...guard,
  SHOT_SETTLE_MS: 0,
  prepareShotHtml: (html: string, origin: string) => {
    order.push('prepare');
    return guard.prepareShotHtml(html, origin);
  },
}));

/** A page with the methods the handler and guardShotPage call. */
function fakeBrowser() {
  const page = {
    setViewport: async () => {},
    emulateMediaFeatures: async () => {},
    setJavaScriptEnabled: async () => {},
    setBypassServiceWorker: async () => {},
    evaluateOnNewDocument: async () => {},
    createCDPSession: async () => ({ send: async () => {} }),
    setRequestInterception: async () => {},
    on: () => {},
    setContent: async () => {
      order.push('setContent');
    },
    goto: async () => {},
    evaluate: async () => {},
    screenshot: async () => JPEG,
  };
  return { newPage: async () => page, close: async () => {} };
}

type Launch = (...a: unknown[]) => Promise<unknown>;
const pptr = puppeteer as unknown as { launch: Launch };
const realLaunch = pptr.launch;
const recordingLaunch: Launch = async () => {
  order.push('launch');
  return fakeBrowser();
};
pptr.launch = recordingLaunch;
afterEach(() => {
  order.length = 0;
  pptr.launch = recordingLaunch;
});
afterAll(() => {
  pptr.launch = realLaunch;
});

async function setup(): Promise<{ env: Env; wt: string }> {
  const env = makeEnv({ BROWSER: {} as Fetcher });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.example.org/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

async function shot(env: Env, wt: string) {
  const ctx = makeCtx();
  const res = await appFetch(
    await sized(
      new Request('https://pinna.test/api/projects/site/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wt },
        body: JSON.stringify({ html: '<html><head></head><body><script>1</script><p>x</p></body></html>', vw: 800, vh: 600 }),
      }),
    ),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

const rows = (env: Env) => (env.raw.query('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n;
const blobs = (env: Env) => (env.ATTACHMENTS as unknown as { keys: () => string[] }).keys().length;
const seedFile = (env: Env) =>
  env.raw.query(
    "INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, NULL, 'p1', ?, 'g.png', 'image/png', ?, 0, 'u_c')",
  );

test('the markup is prepared before the browser is launched; the screenshot is stored', async () => {
  const { env, wt } = await setup();
  const res = await shot(env, wt);
  expect(res.status).toBe(201);
  expect(order).toEqual(['prepare', 'launch', 'setContent']);
  expect([rows(env), blobs(env)]).toEqual([1, 1]);
});

test('the project reaches the file cap while the page renders: the insert refuses, nothing stored', async () => {
  const { env, wt } = await setup();
  const ins = seedFile(env);
  for (let i = 0; i < PROJECT_MAX_ATTACHMENTS - 1; i++) ins.run('s' + i, 'att/s' + i, 1);
  // The read before the render saw room; a file lands during the render.
  pptr.launch = async () => {
    ins.run('late', 'att/late', 1);
    return fakeBrowser();
  };
  const res = await shot(env, wt);
  expect(res.status).toBe(413);
  expect(((await res.json()) as { error: string }).error).toBe('too many attachments in the project (max ' + PROJECT_MAX_ATTACHMENTS + ')');
  expect(rows(env)).toBe(PROJECT_MAX_ATTACHMENTS);
  expect(blobs(env)).toBe(0);
});

test('bytes too: one byte short of the room left, the screenshot is refused inside the insert', async () => {
  const { env, wt } = await setup();
  seedFile(env).run('big', 'att/big', PROJECT_QUOTA_BYTES - JPEG.byteLength + 1);
  const res = await shot(env, wt);
  expect(res.status).toBe(413);
  expect([rows(env), blobs(env)]).toEqual([1, 0]);
});

test('when the file cannot be stored, the row written before it is removed', async () => {
  const { env, wt } = await setup();
  (env.ATTACHMENTS as unknown as { put: unknown }).put = async () => {
    throw new Error('R2 down');
  };
  const res = await shot(env, wt);
  expect(res.status).toBe(502);
  expect(rows(env)).toBe(0);
});
