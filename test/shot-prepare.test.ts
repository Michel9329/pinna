/**
 * Pinna - prepareShotHtml runs on up to 3 MB of markup sent by the caller. It
 * must take linear time (regular expressions like /<script[\s\S]*?<\/script\s*>/gi
 * are quadratic on "<script" repeated with no closing tag) and give the same
 * output as those expressions on any input.
 */
import { test, expect } from 'bun:test';
import { prepareShotHtml } from '../worker/shot-guard';

const ORIGIN = 'https://staging.test';
const MB3 = 3 * 1024 * 1024;

/** The previous, regex-based version: the reference for the output. */
function reference(html: string, stagingOrigin: string): string {
  let snap = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const baseTag = '<base href="' + stagingOrigin + '/">';
  snap = /<head[^>]*>/i.test(snap) ? snap.replace(/<head([^>]*)>/i, '<head$1>' + baseTag) : baseTag + snap;
  return snap;
}

function timed(input: string): number {
  const t = performance.now();
  prepareShotHtml(input, ORIGIN);
  return performance.now() - t;
}

test('3 MB of "<script " with no closing tag: prepared in well under a second', () => {
  const input = '<script '.repeat(MB3 / 8);
  expect(timed(input)).toBeLessThan(500);
  expect(prepareShotHtml(input, ORIGIN)).toBe('<base href="https://staging.test/">' + input);
});

test('3 MB of "<base " with no ">", and of "<noscript ", "</script" and "<head ": well under a second each', () => {
  for (const unit of ['<base ', '<noscript ', '<script></script', '<head ', '<BASE\n']) {
    const input = unit.repeat(Math.floor(MB3 / unit.length));
    expect(timed(input)).toBeLessThan(500);
  }
});

test('same output as the regex version on normal documents', () => {
  const docs = [
    '<!doctype html><html><head><meta charset="utf-8"><title>T</title><base href="https://evil.test/"></head><body><p>x</p></body></html>',
    '<html><HEAD lang="en"><SCRIPT src="/a.js"></SCRIPT ><script>var a = "</scrip";</script>\n<noscript><iframe src="x"></iframe></noscript></HEAD><body>ok</body></html>',
    '<body><script>1</script  >between<script>2</script\n>after<noscript>n</NOSCRIPT></body>',
    '<header>no head tag</header><base target="_blank"><basement>kept</basement>',
    'plain text, no tags at all',
    '<head><script>never closed',
    '<head data-x="1"><script type="module">import x from "/x.js"</script></head>',
  ];
  for (const d of docs) expect(prepareShotHtml(d, ORIGIN)).toBe(reference(d, ORIGIN));
});

test('same output as the regex version on random markup (fuzz)', () => {
  const parts = ['<script', '</script', '<SCRIPT', '</Script', '<noscript', '</noscript', '<base', '<BASE', '<basex',
    '<head', '<HEAD', '<header', '>', ' ', '\n', '\t', ' ', 'a', '_', '1', '<', '/', '"', 'x>'];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 3000; round++) {
    let s = '';
    const len = 1 + rnd(24);
    for (let i = 0; i < len; i++) s += parts[rnd(parts.length)];
    const got = prepareShotHtml(s, ORIGIN);
    const want = reference(s, ORIGIN);
    if (got !== want) throw new Error('mismatch on ' + JSON.stringify(s) + ': ' + JSON.stringify(got) + ' vs ' + JSON.stringify(want));
  }
});
