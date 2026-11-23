/**
 * SECURITY.md must keep its list of open limits and the sentences that tell an
 * installer what the code does. The "Known limits" section is the honest part
 * of the security document: these tests fail if an entry is dropped or its key
 * facts are edited away, so the list cannot shrink silently. Adding entries is
 * fine; removing one means changing this test on purpose. The same holds for
 * the security-relevant sentences elsewhere in SECURITY.md and in the README.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name: string) => readFileSync(join(import.meta.dir, '..', name), 'utf-8').replace(/\r\n/g, '\n');
const doc = read('SECURITY.md');
const readme = read('README.md');

/** Text of a `## ` section, up to the next `## ` heading or the end of the file. */
function section(heading: string, text: string = doc): string {
  const start = text.indexOf('\n## ' + heading + '\n');
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 4);
  return text.slice(start, next < 0 ? undefined : next);
}

/** Whitespace flattened, so that line wrapping does not matter. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const limits = section('Known limits');
/** One string per bullet, with its wrapped lines joined. */
const bullets = limits
  .split(/\n- /)
  .slice(1)
  .map((b) => flat(b));

test('SECURITY.md has a Known limits section with one bullet per limit', () => {
  expect(limits.length).toBeGreaterThan(0);
  expect(bullets.length).toBeGreaterThanOrEqual(16);
});

test('SECURITY.md tells how to report a vulnerability privately', () => {
  expect(doc).toContain('Report a vulnerability');
  expect(doc).toContain('Do not open a public issue');
});

// Each entry: what the limit is about, and the facts that must stay in one bullet.
const required: [string, RegExp[]][] = [
  ['proxy token in the frame URL', [/pinna_pt/, /logout/i, /off by default/]],
  ['DNS rebinding', [/DNS rebinding/, /Browser Run/]],
  [
    'global email cap stops email sign-in for every client',
    [/Global email cap/, /all clients for 24 hours/, /neither the code nor the link/, /PINNA_EMAIL_DAILY_CAP/],
  ],
  ['code sign-in can be switched off from outside', [/20 wrong codes in 24 hours/]],
  ['response time of the sign-in request', [/100 to 300 ms/, /registered address/]],
  ['in-memory shields are approximate', [/ANON_RL/, /USER_RL/, /per Cloudflare location/]],
  ['per-IP cap on the admin key', [/10 failures in an hour/, /right key/]],
  [
    'widget token readable by the staging page',
    [
      /refreshed tokens/,
      /upload files and request screenshots/,
      /\?at=/,
      /delete the user's own replies and the user's own pins whose whole thread is the user's/,
      /not even as part of a thread/,
    ],
  ],
  [
    'project quotas can be filled with a widget token',
    [
      /Project quotas can be filled with a widget token/,
      /2 million characters/,
      /enforced inside the write, so parallel requests cannot go past them, but they can still be reached/,
      /a member acting in bad faith/,
    ],
  ],
  ['an ADMIN_EMAILS list that removes no admin', [/ADMIN_EMAILS/, /missing configuration/, /two steps/]],
  ['/shot in URL mode runs without JavaScript', [/\/shot/, /JavaScript off/, /blank/]],
  ['the confirmation bar can be triggered by the staging site', [/confirmation bar can be triggered by the staging site/, /nothing happens unless the admin clicks it/]],
  ['project slugs can be probed', [/Project slugs can be probed/, /404/, /403/]],
  [
    'a thread can change between the check and the delete',
    [/A thread can change between the check and the delete/, /without the admin rule/, /stays in R2 without a row/],
  ],
  [
    'stored selectors run in every viewer\'s browser',
    [/Stored selectors run in every viewer's browser/, /`querySelector`/, /1,000 characters/, /has not been measured/],
  ],
  ['alert emails can repeat', [/Alert emails can repeat/, /not atomic/, /a few alert emails instead of one/]],
];

for (const [name, patterns] of required) {
  test('Known limits keeps: ' + name, () => {
    const hit = bullets.find((b) => patterns.every((p) => p.test(b)));
    expect(hit).toBeDefined();
  });
}

const roles = flat(section('Roles'));
const tokens = flat(section('Tokens and credentials'));
const signIn = flat(section('Sign-in'));
const quotas = flat(section('Rate limits and quotas'));
const uploads = flat(section('Uploads and files'));
const shots = flat(section('Server-side screenshots'));
const frame = flat(section('The review frame'));
const proxy = flat(section('The review proxy'));
const retention = flat(section('Data retention'));

test('roles: deleting a pin follows the admin rule when the thread holds other people\'s work', () => {
  expect(roles).toMatch(/Deleting a pin deletes its whole thread/);
  expect(roles).toMatch(/the admin rule applies to the pin's author too: the widget token is refused \(403\)/);
  expect(roles).toMatch(/A reply can still be deleted on its own by its author/);
  expect(roles).toMatch(/their own pins whose whole thread is theirs/);
});

test('roles: the comment list returns a fixed set of fields', () => {
  expect(roles).toMatch(/uses one fixed set of fields/);
  expect(roles).toMatch(/`author_role` is the author's role on this project/);
  expect(roles).toMatch(/Author ids, global roles, uploader ids, file sizes and storage keys are not sent/);
});

test('tokens: the widget writes no token to storage, only two sessionStorage keys', () => {
  expect(tokens).toMatch(/No token is written to storage/);
  expect(tokens).toContain('`__pinna_ctx`');
  expect(tokens).toContain('`__pinna_frame`');
});

test('tokens: widget token powers and the confirmation bar', () => {
  expect(tokens).toMatch(/delete the user's own replies and the user's own pins whose whole thread is theirs/);
  expect(tokens).toMatch(/deleting a pin whose thread holds someone else's work/);
  expect(tokens).toMatch(/only when the user is an admin of the project/);
  expect(tokens).toMatch(/even when the two messages arrive in the same tick/);
  expect(tokens).toMatch(/delete the comment and its N replies/);
});

test('sign-in: the link page shows the masked account and refuses dead links', () => {
  expect(signIn).toMatch(/names the account the link signs into, masked/);
  expect(signIn).toMatch(/`a\*\*\*@example\.com`/);
  expect(signIn).toMatch(/An unknown, used or expired link gets no page: it redirects to the sign-in page \(`\/login\?err=expired`\)/);
});

test('quotas: project caps are part of the write; selector and proxy body caps', () => {
  expect(quotas).toMatch(/The two project caps are part of the write itself/);
  expect(quotas).toMatch(/only the ones that fit are written; the others get the usual 413/);
  expect(quotas).toMatch(/selector up to 1,000/);
  expect(quotas).toMatch(/2 MB for proxied requests that have a body/);
});

test('uploads: row first, file names cleaned, old drafts not linkable', () => {
  expect(uploads).toMatch(/The database row is written first/);
  expect(uploads).toMatch(/If that write fails, the row is removed/);
  expect(uploads).toMatch(/at most 200 characters, keeping an extension of up to 20/);
  expect(uploads).toMatch(/only drafts younger than 24 hours/);
});

test('screenshots: says what leaves the browser in the html snapshot', () => {
  expect(shots).toMatch(/whole document as it is in the reviewer's browser, not only the visible part/);
  expect(shots).toMatch(/hidden inputs/);
  expect(shots).toMatch(/inline scripts and JSON blocks/);
  expect(shots).toMatch(/`<script>` is removed only on the server/);
  expect(shots).toMatch(/Typed text is included only where the site's framework writes it into the `value` attribute/);
});

test('screenshots: says when the snapshot is sent and how long the draft lives', () => {
  expect(shots).toMatch(/On the click that places the pin, before the comment is written/);
  expect(shots).toMatch(/Cancelling the comment does not undo it/);
  expect(shots).toMatch(/between 24 and 48 hours; after 24 hours it can no longer be linked to a comment/);
  expect(shots).toMatch(/even when the instance has no `BROWSER` binding/);
  expect(shots).toMatch(/Not the markup/);
  expect(shots).toMatch(/Only the JPEG is stored/);
});

test('screenshots: own size against the caps, discarded after rendering, markup cleaned before the browser', () => {
  expect(shots).toMatch(/counts against the project's file caps with its own size/);
  expect(shots).toMatch(/discarded with a 413 and never stored/);
  expect(shots).toMatch(/runs in linear time and before the browser is launched/);
});

test('screenshots: says what the stored selector is built from, who reads it and its cap', () => {
  expect(shots).toMatch(/### What a pin takes from the page/);
  expect(shots).toMatch(/up to five of its ancestors/);
  expect(shots).toMatch(/`data-\*` attribute names with values of up to 60 characters/);
  expect(shots).toMatch(/every member of the project can read it/);
  expect(shots).toMatch(/selectors of up to 1,000 characters \(400 beyond\)/);
  expect(shots).toMatch(/the widget sends none and the pin falls back to its page coordinates/);
});

test('review frame: the sandbox tokens and no top navigation', () => {
  expect(frame).toContain(
    '`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`',
  );
  expect(frame).toMatch(/there is no top-navigation token/);
  expect(frame).toMatch(/cannot navigate the reviewer's Pinna tab away/);
});

test('proxy: request bodies need a length and stop at 2 MB', () => {
  expect(proxy).toMatch(/needs a `Content-Length` \(411 without\) of at most 2 MB \(413 over\)/);
});

test('retention: drafts past the sweep age are not linked', () => {
  expect(retention).toMatch(/A draft of that age is also refused when a comment tries to link it/);
});

test('README: the security-relevant sentences match SECURITY.md', () => {
  const r = flat(readme);
  expect(r).toMatch(/The snapshot is the whole document, not only the visible part/);
  expect(r).toMatch(/even if the reviewer then cancels the comment, and even when screenshots are not configured/);
  expect(r).toMatch(/its author can delete it only while every reply and file in it is theirs/);
  expect(r).toMatch(/names the account the link signs into, masked/);
  expect(r).toMatch(/Links and scripts on the site that target the top window do not navigate Pinna's tab/);
  expect(r).toMatch(/A request with a body needs a `Content-Length` and stops at 2 MB/);
  expect(r).toMatch(/two confirmation requests posted together, where the second is refused/);
  expect(r).toMatch(/in a phone-sized frame/);
});

test('roles: one comment shape for list, create and edit; files carry `mine`', () => {
  expect(roles).toMatch(/Every answer that returns comments uses one fixed set of fields: the list \(`GET \/api\/projects\/:slug\/comments`\), a new comment and an edit/);
  expect(roles).toMatch(/and `mine`: whether the requester uploaded it/);
  expect(roles).toMatch(/A new comment also gets `attachments_linked` and `attachments_requested`; an edit of a comment that no longer exists gets 404/);
});

test('roles: the widget deletes directly only an all-own thread or an own file, and falls back on a refusal', () => {
  expect(roles).toMatch(/only when the pin, every reply and every file in the thread are theirs/);
  expect(roles).toMatch(/a project admin's widget goes on through the confirmation bar, and a client's widget says that only a project admin can delete the thread/);
  expect(roles).toMatch(/the widget removes directly only a file the reader uploaded; any other file goes through the confirmation bar for a project admin, and a client reads that only a project admin can remove it/);
});

test('sign-in: both link routes pass the anonymous shield first', () => {
  expect(signIn).toMatch(/Both link routes, `GET` and `POST \/api\/auth\/verify`, first pass the `ANON_RL` shield/);
  expect(signIn).toMatch(/the link page answers 429 with a small HTML page \(wait a minute and reload, the link is still valid\) and a `Retry-After` header; the POST answers 429 in JSON/);
  expect(quotas).toMatch(/\| Link page and link sign-in per IP \| 10 per minute each \| `ANON_RL` \| open \|/);
});

test('quotas: control characters are removed from the text, and why', () => {
  expect(quotas).toMatch(/Control characters are removed from comment text, on create and on edit, before validation/);
  expect(quotas).toMatch(/a text pasted from Word brings U\+000B/);
  expect(quotas).toMatch(/the NUL is gone before the count/);
  expect(quotas).toMatch(/A selector that holds a control character is stored as null and the pin keeps its coordinates. A page path that holds one is refused \(400\)/);
});

test('uploads: the stored name agrees with the detected type, at upload and at download', () => {
  expect(uploads).toMatch(/Its extension is also made to agree with the type read from the file's first bytes/);
  expect(uploads).toMatch(/a PDF named `invoice.cmd` is stored as `invoice.cmd.pdf`/);
  expect(uploads).toMatch(/could be run, as a Windows batch file/);
  expect(uploads).toMatch(/goes through the same type rule again, so rows stored before the rule are covered/);
  expect(uploads).toMatch(/cut at 200 characters, and then gets the type's extension again, because the cut can drop it/);
});

test('README: L1 to L6 sentences', () => {
  const r = flat(readme);
  expect(r).toMatch(/the stored name gets that type's extension when it lacks one/);
  expect(r).toMatch(/plus `attachments_linked` and `attachments_requested`/);
  expect(r).toMatch(/404 if it no longer exists/);
  expect(r).toMatch(/where the admin's delete goes on through the confirmation bar and a client is told that only a project admin can delete it/);
  expect(r).toMatch(/where the pin is saved without a selector, on its coordinates/);
  expect(r).toMatch(/Control characters are removed from the text; a page path that holds one gets 400/);
  expect(r).toMatch(/past the per-IP limit, a 429 page that asks to wait a minute and reload/);
  expect(r).toMatch(/a file with no recorded uploader on one's own comment, which the admin removes through the confirmation bar/);
});
