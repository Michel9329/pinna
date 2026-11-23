/**
 * Pinna - global admins from ADMIN_EMAILS.
 *
 * ADMIN_EMAILS is the source of the global admin role, checked on every
 * request. If it only PROMOTED at sign-in, whoever became admin would stay
 * admin forever, even after their email was removed from the list
 * (users.role would stay 'admin' and the 30-day session would remain valid).
 * So:
 *  - admin in the DB but not in the list: demoted to 'client' (per-project
 *    roles remain on the memberships), sessions and widget tokens revoked
 *    (cutoff in session_revocations), the current request answers 401;
 *  - in the list but not admin in the DB: promoted;
 *  - at sign-in (verify, verify-code) the same check runs before the session
 *    is signed, so nobody gets in with a stale role;
 *  - the daily cron also demotes users who make no requests (syncAdmins), and
 *    notifications skip admins who are no longer in the list.
 *
 * Missing list: with ADMIN_EMAILS absent, empty or without any valid address
 * (e.g. written with a separator that is not recognized) the list does NOT
 * mean "no admins": it is missing configuration. Otherwise, on a first deploy
 * without the variable, the existing admin would be demoted and locked out
 * on the first request (including from the widget) and by the 03:00 cron.
 * Without a valid list, roles stay as they are in the DB: no promotion, no
 * demotion, no revocation, the cron skips, and an error is logged (once per
 * isolate). Demotion happens only with a valid, non-empty list that does not
 * contain the email.
 *
 * List that contains none of the DB admins: a wrong but well-formed list (a
 * typo, for example) would demote the existing admin, and /entra would create
 * and sign in to a phantom admin named after the first address. So if the DB
 * has admins and none of them is in the list, it is treated as missing
 * configuration, like an empty list: no promotion, no demotion, /entra does
 * not sign in, error in the logs. On a new instance (no admins in the DB) the
 * list applies and the first sign-in creates the admin. To hand the instance
 * over to another admin: add the new one, have them sign in, then remove the
 * old one.
 */
import type { Env, User } from './types';
import { adminEmails, isAdminEmail } from './auth';
import { warnConfigOnce } from './config';
import * as db from './db';

/**
 * State of ADMIN_EMAILS:
 *  - 'missing': no valid address, or the DB has admins and none of them is in
 *    the list. Roles come from the DB, no promotion or demotion.
 *  - 'bootstrap': valid addresses and no admin in the DB (new instance): a
 *    listed address becomes admin on its first sign-in.
 *  - 'ok': at least one address in the list is a DB admin: the list decides.
 * The DB is queried only when the list is valid.
 */
export type AdminListState = 'missing' | 'bootstrap' | 'ok';

export async function adminListState(env: Env): Promise<AdminListState> {
  const listed = adminEmails(env);
  if (!listed.length) {
    warnConfigOnce(
      'admin-emails',
      'ADMIN_EMAILS missing or without valid addresses: admin roles taken from the DB, no demotion (see README, "First admin")',
    );
    return 'missing';
  }
  const admins = await db.listGlobalAdmins(env.DB);
  if (!admins.length) return 'bootstrap';
  if (admins.some((u) => listed.includes(u.email.trim().toLowerCase()))) return 'ok';
  warnConfigOnce(
    'admin-emails-nomatch',
    'ADMIN_EMAILS contains none of the DB admins: treated as missing, no demotion or promotion, /entra disabled (see README, "First admin")',
  );
  return 'missing';
}

/**
 * User role aligned with ADMIN_EMAILS for an authenticated request.
 * Null if the user was admin and no longer is: demoted and sessions revoked.
 * The list state is read only when something would have to change.
 */
export async function applyAdminList(env: Env, user: User): Promise<User | null> {
  const listed = isAdminEmail(user.email, env);
  if (user.role === 'admin' && !listed) {
    if ((await adminListState(env)) !== 'ok') return user;
    await demote(env, user.id);
    return null;
  }
  if (user.role !== 'admin' && listed) {
    if ((await adminListState(env)) === 'missing') return user;
    return db.ensureAdminUser(env.DB, user.email, user.name);
  }
  return user;
}

/**
 * Role to put in the session at sign-in: like applyAdminList, but a demoted
 * user gets in right away as 'client' (no sign-in followed by a 401).
 */
export async function loginRole(env: Env, user: User): Promise<User> {
  const listed = isAdminEmail(user.email, env);
  if (user.role === 'admin' && !listed) {
    if ((await adminListState(env)) !== 'ok') return user;
    await demote(env, user.id);
    return { ...user, role: 'client' };
  }
  if (user.role !== 'admin' && listed) {
    if ((await adminListState(env)) === 'missing') return user;
    return db.ensureAdminUser(env.DB, user.email, user.name);
  }
  return user;
}

/**
 * True if the user is a global admin (notifications, email reserve): admin in
 * the DB and in the list; with a missing list (adminListState) the DB decides.
 */
export async function isListedAdmin(env: Env, user: Pick<User, 'role' | 'email'>): Promise<boolean> {
  if (user.role !== 'admin') return false;
  if (isAdminEmail(user.email, env)) return true;
  return (await adminListState(env)) !== 'ok';
}

/**
 * Can a listed address that requests access become admin
 * (/auth/request)? Yes, unless the list is missing.
 */
export async function canPromoteListed(env: Env, email: string): Promise<boolean> {
  return isAdminEmail(email, env) && (await adminListState(env)) !== 'missing';
}

/** Cron: demotes the DB admins no longer in ADMIN_EMAILS. Returns how many. */
export async function syncAdmins(env: Env): Promise<number> {
  // Missing list: nothing to compare against, no demotion.
  if ((await adminListState(env)) !== 'ok') return 0;
  const admins = await db.listGlobalAdmins(env.DB);
  let n = 0;
  for (const u of admins) {
    if (isAdminEmail(u.email, env)) continue;
    await demote(env, u.id);
    n++;
  }
  return n;
}

async function demote(env: Env, userId: string): Promise<void> {
  await db.demoteAdmin(env.DB, userId);
  // Cutoff now: the sessions and widget tokens issued as admin stop working.
  await db.revokeSessions(env.DB, userId, Date.now());
  console.log('[pinna] admin demoted (email no longer in ADMIN_EMAILS):', userId);
}
