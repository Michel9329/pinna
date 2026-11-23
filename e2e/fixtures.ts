/**
 * Pinna - e2e, shared fixtures: baseURL from the startup (globalSetup), the
 * browser name, sign-in with the dev mode code.
 */
import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ browserTag: string }>({
  // The wrangler dev port is picked at startup: baseURL comes from there.
  baseURL: async ({}, use) => {
    const b = process.env.PINNA_E2E_BASE;
    if (!b) throw new Error('PINNA_E2E_BASE missing: run with `bun run test:e2e`');
    await use(b);
  },
  browserTag: async ({}, use, info) => {
    await use(info.project.name);
  },
});

export { expect };

/** Requests the code from the sign-in page (dev mode: it comes back in the response). */
export async function requestCode(page: Page, email: string): Promise<{ devLink: string; devCode: string }> {
  await page.goto('/login');
  await page.getByLabel('Your email').fill(email);
  // The anonymous shield (ANON_RL, 10 requests a minute per address) applies
  // here too: the whole suite comes from 127.0.0.1. If a fast run goes over
  // it, wait for Retry-After and try once more, as a person would.
  let res = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resP = page.waitForResponse((r) => r.url().endsWith('/api/auth/request') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Email me a code' }).click();
    res = await resP;
    if (res.status() !== 429) break;
    const wait = Math.min(65, Number(res.headers()['retry-after'] || '60') + 2);
    await page.waitForTimeout(wait * 1000);
  }
  expect(res!.status()).toBe(200);
  const body = (await res!.json()) as { devLink?: string; devCode?: string };
  expect(body.devCode, 'dev mode off? devCode is missing').toMatch(/^\d{6}$/);
  expect(body.devLink).toContain('/api/auth/verify?token=');
  return { devLink: body.devLink as string, devCode: body.devCode as string };
}

/** Full sign-in with the 6-digit code, typed into the page as a client would. */
export async function loginWithCode(page: Page, email: string): Promise<void> {
  const { devCode } = await requestCode(page, email);
  await page.getByLabel('Sign-in code').fill(devCode);
  const verP = page.waitForResponse((r) => r.url().endsWith('/api/auth/verify-code'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await verP).status()).toBe(200);
}

/** User of the current session (or the HTTP status if there is none). */
export async function me(page: Page): Promise<{ status: number; email?: string; role?: string }> {
  const r = await page.request.get('/api/auth/me');
  if (!r.ok()) return { status: r.status() };
  const u = (await r.json()) as { email: string; role: string };
  return { status: r.status(), email: u.email, role: u.role };
}
