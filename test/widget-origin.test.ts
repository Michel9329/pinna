/**
 * Pinna - origin of the widget API. If the widget took the API base from
 * ?pinna_api=, anyone framing the staging with ?pinna_pm=1&pinna_api=<their
 * site> would complete the handshake and receive comments and DOM snapshots.
 * In postMessage mode the only trusted origin is the one pinna.js is loaded
 * from.
 *
 * The widget runs here in a vm context with a minimal browser environment:
 * enough for the handshake (which happens before the DOM is touched).
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SRC = readFileSync(join(import.meta.dir, '..', 'widget', 'pinna.js'), 'utf-8');
const PINNA = 'https://pinna.example.com';
const EVIL = 'https://evil.test';

function runWidget(search: string, dataset: Record<string, string> = {}) {
  const listeners: [string, (e: unknown) => void][] = [];
  const removed: unknown[] = [];
  const toParent: [unknown, string][] = [];
  const win: Record<string, unknown> = {
    URLSearchParams,
    URL,
    JSON,
    Promise,
    // Fake timers: the handshake timeout must not fire during the test.
    setTimeout: () => 0,
    clearTimeout: () => {},
    location: { search, href: 'https://staging.test/' + search, pathname: '/', ancestorOrigins: [] },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    parent: { postMessage: (m: unknown, o: string) => toParent.push([m, o]) },
    addEventListener: (t: string, h: (e: unknown) => void) => listeners.push([t, h]),
    removeEventListener: (_t: string, h: unknown) => removed.push(h),
    document: { currentScript: { src: PINNA + '/pinna.js', dataset } },
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  const send = (origin: string, data: unknown) => {
    for (const [t, h] of listeners) if (t === 'message') h({ origin, data, source: win.parent });
  };
  return { listeners, removed, toParent, send };
}

test('postMessage mode: an init from ?pinna_api=<another site> is ignored', async () => {
  const w = runWidget('?pinna_pm=1&pinna_project=site&pinna_api=' + encodeURIComponent(EVIL));
  await Promise.resolve();
  expect(w.listeners.some(([t]) => t === 'message')).toBe(true);
  w.send(EVIL, { type: 'pinna-init', token: 'fake-token', project: 'site' });
  // The handler removes itself only when it accepts an init: not here.
  expect(w.removed.length).toBe(0);
});

test('proxy mode: the hello goes to the origin of pinna.js, not to ?pinna_api=', async () => {
  const w = runWidget('?pinna_pm=1&pinna_pt=pt123&pinna_api=' + encodeURIComponent(EVIL), { pinnaProxy: '1' });
  await Promise.resolve();
  expect(w.toParent.length).toBe(1);
  expect(w.toParent[0]![1]).toBe(PINNA);
  expect((w.toParent[0]![0] as { type: string }).type).toBe('pinna-hello');
});
