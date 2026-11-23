/**
 * Pinna - e2e, widget on the sample site: (d) the client creates, edits and
 * deletes their own comment with an attached image; (e) the admin resolves
 * and deletes SOMEONE ELSE's comment through the app's confirmation bar
 * (session + CSRF), not through the widget-token; (g) on a phone-sized frame
 * the floating buttons do not cover the bottom sheet's buttons; (h) the admin
 * confirmation bar takes one request at a time; (i) a delete refused because
 * the thread changed under an open popover; (j) selectors that cannot be
 * stored; (k) a file with no recorded uploader on one's own comment.
 * In the three browsers.
 */
import type { FrameLocator, Page } from '@playwright/test';
import { test, expect, loginWithCode } from './fixtures';
import { ADMIN, PROJECT, clientEmail, otherCommentBody, legacyFileBody } from './data';

// Valid 1x1 PNG (passes the magic number check in upload-guard.ts).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PROJECT_URL = /\/p\/acme-test-site/;

interface ApiComment {
  id: string;
  parent_id: string | null;
  anchor_selector: string | null;
  page_x: number | null;
  body: string;
  status: 'open' | 'done';
  mine: boolean;
  attachments: { id: string; filename: string }[];
}

/** The sample site inside the app frame, with the widget ready (handshake done). */
async function siteFrame(page: Page): Promise<FrameLocator> {
  await expect(page).toHaveURL(PROJECT_URL);
  // Direct mode is sandboxed too, without any top-navigation token: a script
  // on the staging site cannot navigate the reviewer's Pinna tab. Everything
  // below (handshake, comments, uploads, the confirmation bar) runs under it.
  await expect(page.locator('iframe.site')).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
  );
  const site = page.frameLocator('iframe.site');
  await expect(site.getByRole('heading', { name: 'Acme Test Site' })).toBeVisible();
  // The FAB appears only after pinna-init (token via postMessage) = LIVE widget.
  await expect(site.getByRole('button', { name: 'Open comment mode' })).toBeVisible({ timeout: 20_000 });
  return site;
}

/** Comments of the project as seen by the app session (cookie). */
async function apiComments(page: Page): Promise<ApiComment[]> {
  const r = await page.request.get('/api/projects/' + PROJECT.slug + '/comments');
  expect(r.status()).toBe(200);
  return (await r.json()) as ApiComment[];
}

test('(d) widget: own comment with an image, edit, delete', async ({ page, browserTag }) => {
  await loginWithCode(page, clientEmail('widget', browserTag));
  const site = await siteFrame(page);
  const text = 'Move the title a bit lower (' + browserTag + ')';
  const edited = 'Title a bit lower and bigger (' + browserTag + ')';

  // Comment mode, click on a spot of the page.
  await site.getByRole('button', { name: 'Open comment mode' }).click();
  // Real screenshot (/shot): the sample staging is on 127.0.0.1, an internal
  // host, so /shot answers 400 before opening a Chrome (no download, no cost).
  // The comment must go out anyway, without the picture.
  const shotP = page.waitForResponse((r) => r.url().endsWith('/shot') && r.request().method() === 'POST');
  await site.locator('.catcher').click({ position: { x: 640, y: 260 } });
  const shot = await shotP;
  expect(shot.status()).toBe(400);

  const composer = site.getByRole('dialog', { name: 'New comment' });
  await expect(composer).toBeVisible();
  await composer.locator('textarea#pinna-new').fill(text);

  // Attachment: uploaded as soon as the file is chosen (POST /attachments, widget-token).
  const upP = page.waitForResponse((r) => r.url().endsWith('/attachments') && r.request().method() === 'POST');
  await composer.locator('input.att-input').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: PNG });
  const up = await upP;
  expect(up.status()).toBe(201);
  expect(up.request().headers()['authorization'] || '').toMatch(/^Bearer /);
  await expect(composer.locator('.att-chip .att-name')).toHaveText('test.png');

  const sendP = page.waitForResponse((r) => r.url().endsWith('/comments') && r.request().method() === 'POST');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = await sendP;
  expect(sent.status()).toBe(201);
  const created = (await sent.json()) as { id: string; attachments_linked: number };
  expect(created.attachments_linked).toBe(1);

  // The thread opens with the text and the thumbnail (loaded with the Authorization header).
  const msg = site.locator('.msg').filter({ hasText: text });
  await expect(msg.locator('.msg-body')).toHaveText(text);
  await expect(msg.locator('img.att-img')).toHaveAttribute('src', /^data:image\/png/);
  let mine = (await apiComments(page)).find((c) => c.id === created.id);
  expect(mine?.mine).toBe(true);
  expect(mine?.attachments.map((a) => a.filename)).toEqual(['test.png']);
  const attId = mine!.attachments[0]!.id;

  // Edit the text (only the author sees "edit").
  await msg.getByRole('button', { name: 'edit' }).click();
  await site.locator('textarea.edit-ta').fill(edited);
  const patchP = page.waitForResponse((r) => r.url().includes('/api/comments/' + created.id) && r.request().method() === 'PATCH');
  await site.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await patchP).status()).toBe(200);
  await expect(site.locator('.msg-body').filter({ hasText: edited })).toBeVisible();
  mine = (await apiComments(page)).find((c) => c.id === created.id);
  expect(mine?.body).toBe(edited);

  // Delete the own comment, attachment included.
  const delP = page.waitForResponse((r) => r.url().includes('/api/comments/' + created.id) && r.request().method() === 'DELETE');
  await site.getByRole('button', { name: 'Delete comment' }).click();
  expect((await delP).status()).toBe(200);
  await expect(site.locator('.msg-body').filter({ hasText: edited })).toHaveCount(0);
  expect((await apiComments(page)).some((c) => c.id === created.id)).toBe(false);
  expect((await page.request.get('/api/attachments/' + attId)).status()).toBe(404);
});

test('(e) admin: resolves and deletes someone else\'s comment from the app confirmation bar', async ({ page, browserTag }) => {
  const body = otherCommentBody(browserTag);
  await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
  await page.goto('/p/' + PROJECT.slug);
  const site = await siteFrame(page);
  const target = (await apiComments(page)).find((c) => c.body === body);
  expect(target, 'seeded client comment').toBeTruthy();
  expect(target!.mine).toBe(false);
  const id = target!.id;

  // From the widget's comment list to the client's thread.
  await site.getByRole('button', { name: 'Open comments list' }).click();
  await site.locator('.sb-item').filter({ hasText: body }).click();
  const thread = site.getByRole('dialog').filter({ hasText: body });
  await expect(thread).toBeVisible();

  // Resolve: the widget asks the app, the app asks for confirmation IN ITS OWN page.
  await thread.getByRole('button', { name: 'Mark as done' }).click();
  const bar = page.locator('.admin-confirm');
  await expect(bar).toContainText('Mark the comment as done?');
  await expect(bar).toContainText(body);
  const patchP = page.waitForResponse((r) => r.url().includes('/api/comments/' + id) && r.request().method() === 'PATCH');
  await bar.locator('.ac-go').click();
  const patch = await patchP;
  expect(patch.status()).toBe(200);
  // It is sent by the app (cookie + CSRF), not with the widget-token.
  expect(patch.request().frame().url()).not.toContain('127.0.0.1');
  expect(patch.request().headers()['authorization']).toBeUndefined();
  expect(patch.request().headers()['x-csrf-token'] || '').not.toBe('');
  await expect(bar).toHaveCount(0);
  expect((await apiComments(page)).find((c) => c.id === id)?.status).toBe('done');

  // Delete: same path, confirmation bar with "Delete".
  const reopened = site.getByRole('dialog').filter({ hasText: body });
  await expect(reopened.getByRole('button', { name: 'Reopen comment' })).toBeVisible();
  await reopened.getByRole('button', { name: 'Delete comment' }).click();
  await expect(bar).toContainText('Delete the comment?');
  const delP = page.waitForResponse((r) => r.url().includes('/api/comments/' + id) && r.request().method() === 'DELETE');
  await bar.locator('.ac-go').click();
  const del = await delP;
  expect(del.status()).toBe(200);
  expect(del.request().headers()['authorization']).toBeUndefined();
  await expect(bar).toHaveCount(0);
  expect((await apiComments(page)).some((c) => c.id === id)).toBe(false);
});

/** Creates a comment from the app page with the admin session (cookie + CSRF). */
async function createAsApp(page: Page, payload: Record<string, unknown>): Promise<string> {
  const res = await page.evaluate(
    async ([slug, data]) => {
      const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )__Host-pinna_csrf=([^;]*)/) || [])[1] || '');
      const r = await fetch('/api/projects/' + slug + '/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(data),
      });
      return { status: r.status, body: (await r.json()) as { id: string } };
    },
    [PROJECT.slug, payload] as const,
  );
  expect(res.status).toBe(201);
  return res.body.id;
}

test('(h) admin bar: two requests posted together, the second is refused; deleting a thread names its replies', async ({ page, browserTag }) => {
  await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
  await page.goto('/p/' + PROJECT.slug);
  await siteFrame(page);
  const pin = { page_path: '/', page_x: 200, page_y: 600, viewport: 'desktop', viewport_w: 1440 };
  const xBody = 'Race X (' + browserTag + ')';
  const yBody = 'Race Y (' + browserTag + ')';
  const x = await createAsApp(page, { ...pin, body: xBody });
  const y = await createAsApp(page, { ...pin, page_x: 260, body: yBody });
  await createAsApp(page, { parent_id: y, page_path: '', body: 'First reply' });
  await createAsApp(page, { parent_id: y, page_path: '', body: 'Second reply' });

  // A script on the staging site posts two requests in the same tick: mark X
  // as done, delete Y. Only the first may reach the bar.
  const frame = await (await page.locator('iframe.site').elementHandle())!.contentFrame();
  const results = await frame!.evaluate(
    ([xId, yId]) =>
      new Promise<{ reqId: string; ok: boolean; error?: string }[]>((resolve) => {
        const got: { reqId: string; ok: boolean; error?: string }[] = [];
        addEventListener('message', (e) => {
          const d = e.data as { type?: string; reqId?: string; ok?: boolean; error?: string } | null;
          if (d && d.type === 'pinna-admin-result' && (d.reqId === 'race-1' || d.reqId === 'race-2')) {
            got.push({ reqId: d.reqId, ok: !!d.ok, error: d.error });
          }
        });
        parent.postMessage({ type: 'pinna-admin', reqId: 'race-1', action: 'status', id: xId, status: 'done' }, '*');
        parent.postMessage({ type: 'pinna-admin', reqId: 'race-2', action: 'delete-comment', id: yId }, '*');
        setTimeout(() => resolve(got), 2000);
      }),
    [x, y] as const,
  );
  expect(results).toEqual([{ reqId: 'race-2', ok: false, error: 'another confirmation is pending' }]);
  const bar = page.locator('.admin-confirm');
  await expect(bar).toContainText('Mark the comment as done?');
  await expect(bar).toContainText(xBody);
  const patchP = page.waitForResponse((r) => r.url().includes('/api/comments/' + x) && r.request().method() === 'PATCH');
  await bar.locator('.ac-go').click();
  expect((await patchP).status()).toBe(200);
  await expect(bar).toHaveCount(0);
  let rows = await apiComments(page);
  expect(rows.find((c) => c.id === x)?.status).toBe('done');
  expect(rows.find((c) => c.id === y)?.status).toBe('open');

  // Deleting a pin with replies: the question says the replies go with it.
  await frame!.evaluate((yId) => {
    parent.postMessage({ type: 'pinna-admin', reqId: 'thread-1', action: 'delete-comment', id: yId }, '*');
  }, y);
  await expect(bar).toContainText('Delete the comment and its 2 replies?');
  await expect(bar).toContainText(yBody);
  const delP = page.waitForResponse((r) => r.url().includes('/api/comments/' + y) && r.request().method() === 'DELETE');
  await bar.locator('.ac-go').click();
  expect((await delP).status()).toBe(200);
  rows = await apiComments(page);
  expect(rows.some((c) => c.id === y || c.parent_id === y)).toBe(false);
});

test('(i) a thread that changed under an open popover: the admin goes on through the bar, a client is told why', async ({ page, browser, browserTag }) => {
  const pin = { page_path: '/', page_y: 640, viewport: 'desktop', viewport_w: 1440 };
  await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
  // The client, in a second browser context.
  const ctx2 = await browser.newContext({
    baseURL: process.env.PINNA_E2E_BASE,
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    viewport: { width: 1600, height: 1000 },
  });
  const page2 = await ctx2.newPage();
  await loginWithCode(page2, clientEmail('author', browserTag));
  await expect(page2).toHaveURL(PROJECT_URL);

  // 1. The admin opens their own pin; the client replies while the popover is
  //    open (the widget does not refresh its list then).
  const zBody = 'Admin thread (' + browserTag + ')';
  const z = await createAsApp(page, { ...pin, page_x: 320, body: zBody });
  await page.goto('/p/' + PROJECT.slug);
  const site = await siteFrame(page);
  await site.getByRole('button', { name: 'Open comments list' }).click();
  await site.locator('.sb-item').filter({ hasText: zBody }).click();
  const thread = site.getByRole('dialog').filter({ hasText: zBody });
  await expect(thread).toBeVisible();
  await createAsApp(page2, { parent_id: z, page_path: '', body: 'A reply from the client' });
  const tokenDelete = page.waitForResponse(
    (r) => r.url().includes('/api/comments/' + z) && r.request().method() === 'DELETE' && !!r.request().headers()['authorization'],
  );
  await thread.getByRole('button', { name: 'Delete comment' }).click();
  expect((await tokenDelete).status()).toBe(403);
  const bar = page.locator('.admin-confirm');
  await expect(bar).toContainText('Delete the comment and its 1 reply?');
  const appDelete = page.waitForResponse(
    (r) => r.url().includes('/api/comments/' + z) && r.request().method() === 'DELETE' && !r.request().headers()['authorization'],
  );
  await bar.locator('.ac-go').click();
  expect((await appDelete).status()).toBe(200);
  expect((await apiComments(page)).some((c) => c.id === z || c.parent_id === z)).toBe(false);

  // 2. The client opens their own pin; the admin replies meanwhile. The
  //    client's delete is refused and the widget says why.
  const wBody = 'Client thread (' + browserTag + ')';
  const w = await createAsApp(page2, { ...pin, page_x: 380, body: wBody });
  await page2.goto('/p/' + PROJECT.slug);
  const site2 = await siteFrame(page2);
  await site2.getByRole('button', { name: 'Open comments list' }).click();
  await site2.locator('.sb-item').filter({ hasText: wBody }).click();
  const thread2 = site2.getByRole('dialog').filter({ hasText: wBody });
  await expect(thread2).toBeVisible();
  await createAsApp(page, { parent_id: w, page_path: '', body: 'An admin reply' });
  const clientDelete = page2.waitForResponse((r) => r.url().includes('/api/comments/' + w) && r.request().method() === 'DELETE');
  await thread2.getByRole('button', { name: 'Delete comment' }).click();
  expect((await clientDelete).status()).toBe(403);
  await expect(thread2).toContainText('only a project admin can delete this thread');
  expect((await apiComments(page)).some((c) => c.id === w)).toBe(true);
  await ctx2.close();
});

test('(j) an element id longer than 1,000 characters: the pin is saved without a selector, on its coordinates', async ({ page, browserTag }) => {
  const text = 'Pin on a long id (' + browserTag + ')';
  await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
  await page.goto('/p/' + PROJECT.slug);
  const site = await siteFrame(page);
  const longId = 'x'.repeat(1100);
  const frame = await (await page.locator('iframe.site').elementHandle())!.contentFrame();
  await frame!.evaluate((id) => {
    const d = document.createElement('div');
    d.id = id;
    d.textContent = 'Element with a very long id';
    d.style.cssText = 'position:absolute;left:40px;top:520px;width:420px;height:160px;background:#e2e8f0';
    document.body.appendChild(d);
  }, longId);
  await site.getByRole('button', { name: 'Open comment mode' }).click();
  const shotP = page.waitForResponse((r) => r.url().endsWith('/shot') && r.request().method() === 'POST');
  // The comment-mode overlay receives the click at the element's centre.
  await site.locator('#' + longId).click({ force: true });
  expect([400, 429]).toContain((await shotP).status());
  const composer = site.getByRole('dialog', { name: 'New comment' });
  await composer.locator('textarea#pinna-new').fill(text);
  const sendP = page.waitForResponse((r) => r.url().endsWith('/comments') && r.request().method() === 'POST');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sendP).status()).toBe(201);
  const row = (await apiComments(page)).find((c) => c.body === text);
  expect(row?.anchor_selector).toBeNull();
  expect(row?.page_x).not.toBeNull();

  // A selector built from a data-* value with a tab in it: the widget sends no
  // selector (the server would drop it), the pin keeps its coordinates.
  const tabText = 'Pin on a data value with a tab (' + browserTag + ')';
  await frame!.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:520px;top:520px;width:420px;height:160px';
    for (const v of ['first\tvalue', 'second']) {
      const d = document.createElement('div');
      d.setAttribute('data-card', v);
      d.textContent = v;
      d.style.cssText = 'height:80px;background:#fde68a';
      box.appendChild(d);
    }
    document.body.appendChild(box);
  });
  await site.getByRole('button', { name: 'Open comment mode' }).click();
  const shot2 = page.waitForResponse((r) => r.url().endsWith('/shot') && r.request().method() === 'POST');
  await site.locator('[data-card^="first"]').click({ force: true });
  expect([400, 429]).toContain((await shot2).status());
  const composer2 = site.getByRole('dialog', { name: 'New comment' });
  await composer2.locator('textarea#pinna-new').fill(tabText);
  const sendP2 = page.waitForResponse((r) => r.url().endsWith('/comments') && r.request().method() === 'POST');
  await composer2.getByRole('button', { name: 'Send', exact: true }).click();
  const sent2 = await sendP2;
  expect(sent2.status()).toBe(201);
  expect((sent2.request().postDataJSON() as { anchor_selector: unknown }).anchor_selector).toBeNull();
});

test('(k) a file with no recorded uploader on one\'s own comment: the admin removes it through the bar, a client is told why', async ({ page, browser, browserTag }) => {
  // The admin: the file is not "mine" (no uploader), so the widget asks the app.
  await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
  await page.goto('/p/' + PROJECT.slug);
  const site = await siteFrame(page);
  const adminBody = legacyFileBody('admin', browserTag);
  await site.getByRole('button', { name: 'Open comments list' }).click();
  await site.locator('.sb-item').filter({ hasText: adminBody }).click();
  const thread = site.getByRole('dialog').filter({ hasText: adminBody });
  await expect(thread).toBeVisible();
  await thread.getByRole('button', { name: 'Remove attachment' }).click();
  await thread.getByRole('button', { name: 'Remove', exact: true }).click();
  const bar = page.locator('.admin-confirm');
  await expect(bar).toContainText('Delete the attachment?');
  await expect(bar).toContainText('old-notes.pdf');
  const appDelete = page.waitForResponse(
    (r) => r.url().includes('/api/attachments/a_e2e_legacy_admin_') && r.request().method() === 'DELETE',
  );
  await bar.locator('.ac-go').click();
  const del = await appDelete;
  expect(del.status()).toBe(200);
  expect(del.request().headers()['authorization']).toBeUndefined();

  // The client: the direct delete is refused and the widget says why.
  const ctx2 = await browser.newContext({
    baseURL: process.env.PINNA_E2E_BASE,
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    viewport: { width: 1600, height: 1000 },
  });
  const page2 = await ctx2.newPage();
  await loginWithCode(page2, clientEmail('author', browserTag));
  const site2 = await siteFrame(page2);
  const clientBody = legacyFileBody('client', browserTag);
  await site2.getByRole('button', { name: 'Open comments list' }).click();
  await site2.locator('.sb-item').filter({ hasText: clientBody }).click();
  const thread2 = site2.getByRole('dialog').filter({ hasText: clientBody });
  await expect(thread2).toBeVisible();
  await thread2.getByRole('button', { name: 'Remove attachment' }).click();
  const refused = page2.waitForResponse(
    (r) => r.url().includes('/api/attachments/a_e2e_legacy_client_') && r.request().method() === 'DELETE',
  );
  await thread2.getByRole('button', { name: 'Remove', exact: true }).click();
  expect((await refused).status()).toBe(403);
  await expect(thread2).toContainText('only a project admin can remove it');
  await ctx2.close();
});

test.describe('phone-sized frame', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('(g) widget on a phone: the floating buttons do not cover Send or Delete comment', async ({ page, browserTag }) => {
    const text = 'Comment from a phone (' + browserTag + ')';
    await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
    await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
    await page.goto('/p/' + PROJECT.slug);
    await siteFrame(page);
    // Phone preview: the frame is 390 px wide, so the widget uses its bottom
    // sheet layout (under 600 px).
    await page.getByRole('button', { name: 'Phone', exact: true }).click();
    const frame = page.frameLocator('iframe.site');
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth)).toBe(390);
    // The widget handles a viewport band change after a 120 ms debounce, and
    // that redraw closes any open popover: let it settle before opening one.
    await page.waitForTimeout(500);
    const site = await siteFrame(page);
    const fab = site.getByRole('button', { name: 'Open comment mode' });

    await fab.click();
    // The screenshot is not the subject here: 400 (internal staging host), or
    // 429 when repeated runs hit the 5-a-minute cap of the same admin.
    const shotP = page.waitForResponse((r) => r.url().endsWith('/shot') && r.request().method() === 'POST');
    await site.locator('.catcher').click({ position: { x: 195, y: 300 } });
    expect([400, 429]).toContain((await shotP).status());
    const composer = site.getByRole('dialog', { name: 'New comment' });
    await expect(composer).toBeVisible();
    await composer.locator('textarea#pinna-new').fill(text);

    // A real click: if the FAB or the handle covered Send, Playwright would
    // report that another element receives the click and time out.
    const sendP = page.waitForResponse((r) => r.url().endsWith('/comments') && r.request().method() === 'POST');
    await composer.getByRole('button', { name: 'Send', exact: true }).click({ timeout: 10_000 });
    const sent = await sendP;
    expect(sent.status()).toBe(201);
    const created = (await sent.json()) as { id: string };

    // The thread sheet opens; "Delete comment" sits at its bottom edge too.
    const delP = page.waitForResponse((r) => r.url().includes('/api/comments/' + created.id) && r.request().method() === 'DELETE');
    await site.getByRole('button', { name: 'Delete comment' }).click({ timeout: 10_000 });
    expect((await delP).status()).toBe(200);
    expect((await apiComments(page)).some((c) => c.id === created.id)).toBe(false);

    // With the sheet closed the floating buttons are back.
    await expect(fab).toBeVisible();
    await expect(site.getByRole('button', { name: 'Open comments list' })).toBeVisible();
  });
});
