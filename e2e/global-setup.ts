/**
 * Pinna - e2e, globalSetup: starts a local wrangler dev and the sample site
 * (see setup-lib.ts) and returns the teardown that closes them. The addresses
 * reach the Playwright workers in the PINNA_E2E_* variables.
 */
import { startAll } from './setup-lib';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const run = await startAll();
  process.env.PINNA_E2E_BASE = run.base;
  process.env.PINNA_E2E_SITE = run.site;
  return async () => {
    await run.stop();
  };
}
