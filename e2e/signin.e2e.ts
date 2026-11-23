/**
 * Pinna - e2e, sign-in and sign-out: (a) the email link, (b) the 6-digit
 * code, (c) /entra#k=, (f) sign-out. In the three browsers.
 */
import { test, expect, requestCode, loginWithCode, me } from './fixtures';
import { ADMIN, clientEmail } from './data';

test('(a) email link: page with the button, POST, session', async ({ page, browserTag }) => {
  const email = clientEmail('link', browserTag);
  await requestCode(page, email);
  // As from the email: the dev mode link leads to the page with the button.
  await page.getByRole('link', { name: 'Sign in with the link (dev)' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Pinna' })).toBeVisible();
  expect((await me(page)).status).toBe(401); // the GET does not sign in
  const postP = page.waitForResponse((r) => r.url().endsWith('/api/auth/verify') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const post = await postP;
  // The error message carries the headers that decide sameOriginPost (index.ts).
  const h = await post.request().allHeaders();
  const seen = 'Origin=' + h['origin'] + ' Sec-Fetch-Site=' + h['sec-fetch-site'] + ' Referer=' + h['referer'];
  expect(post.status(), 'the POST from the button must pass the origin check (' + seen + ')').toBe(303);
  // The client lands on their project, with the session.
  await expect(page).toHaveURL(/\/p\/acme-test-site/);
  const u = await me(page);
  expect(u.status).toBe(200);
  expect(u.email).toBe(email);
});

test('(b) 6-digit code typed into the sign-in page', async ({ page, browserTag }) => {
  const email = clientEmail('code', browserTag);
  await loginWithCode(page, email);
  await expect(page).toHaveURL(/\/p\/acme-test-site/);
  const u = await me(page);
  expect(u.status).toBe(200);
  expect(u.email).toBe(email);
  expect(u.role).toBe('client');
});

test('(c) /entra#k=: admin entry with the key in the fragment', async ({ page }) => {
  await page.goto('/entra#k=' + encodeURIComponent(ADMIN.key));
  await expect(page.getByRole('heading', { name: 'Your sites' })).toBeVisible();
  // The key does not stay in the address bar.
  expect(page.url()).not.toContain(ADMIN.key);
  const u = await me(page);
  expect(u.status).toBe(200);
  expect(u.email).toBe(ADMIN.email);
  expect(u.role).toBe('admin');
});

test('(f) sign-out: session closed, back to the sign-in page', async ({ page, browserTag }) => {
  await loginWithCode(page, clientEmail('signout', browserTag));
  await expect(page).toHaveURL(/\/p\/acme-test-site/);
  expect((await me(page)).status).toBe(200);
  const outP = page.waitForResponse((r) => r.url().endsWith('/api/auth/logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect((await outP).status()).toBe(200);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Your email')).toBeVisible();
  expect((await me(page)).status).toBe(401);
  // Reloading the app does not sign back in: a new sign-in is needed.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});
