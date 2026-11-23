/** Pinna - D1 data access. */
import type { User, Project, Comment, NewCommentInput, Attachment } from './types';
import { safeEqual } from './auth';
import { isMissingSchema, consumeSliding, peekSliding, refundSliding } from './rate-limit';

/**
 * Migration 0002 (memberships.role) not applied yet: instead of a 500, memberships
 * degrade to the 'client' role and a line is written to the logs, so the
 * deploy order (Worker before the migration) is not a risk.
 */
function logMissingRole(where: string, e: unknown): void {
  console.error('[pinna] memberships.role missing (migration 0002?), client role in ' + where + ':', (e as Error).message);
}

/** A comment with the author's role (to render "Admin" / "Client"). */
export type CommentRow = Comment & { author_role: string };

/** Url-safe slug from a name (accents removed via NFD + property escape). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

// --- Users --------------------------------------------------------------

export async function getUserByEmail(DB: D1Database, email: string): Promise<User | null> {
  return DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email.trim().toLowerCase())
    .first<User>();
}

export async function getUserById(DB: D1Database, id: string): Promise<User | null> {
  return DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

/** Creates a client user if it does not exist; returns the existing or the new one. */
export async function ensureClientUser(
  DB: D1Database,
  email: string,
  name: string | null,
): Promise<User> {
  const norm = email.trim().toLowerCase();
  const existing = await getUserByEmail(DB, norm);
  if (existing) return existing;
  const user: User = {
    id: crypto.randomUUID(),
    email: norm,
    role: 'client',
    name,
    created_at: Date.now(),
  };
  await DB.prepare(
    'INSERT OR IGNORE INTO users (id, email, role, name, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(user.id, user.email, user.role, user.name, user.created_at)
    .run();
  // Tolerates a concurrent first-login race: if another request has already
  // created the row (UNIQUE email), OR IGNORE does nothing -> read it again and return it.
  return (await getUserByEmail(DB, norm)) || user;
}

/**
 * Ensures an ADMIN user (role 'admin') for the allowlisted emails. Creates it
 * if missing, UPGRADES it if it exists as 'client'. Never downgrades. Returns
 * the admin user.
 */
export async function ensureAdminUser(
  DB: D1Database,
  email: string,
  name: string | null,
): Promise<User> {
  const norm = email.trim().toLowerCase();
  const existing = await getUserByEmail(DB, norm);
  if (existing) {
    if (existing.role !== 'admin') {
      await DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('admin', existing.id).run();
      existing.role = 'admin';
    }
    return existing;
  }
  const user: User = {
    id: crypto.randomUUID(),
    email: norm,
    role: 'admin',
    name,
    created_at: Date.now(),
  };
  await DB.prepare(
    'INSERT OR IGNORE INTO users (id, email, role, name, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(user.id, user.email, user.role, user.name, user.created_at)
    .run();
  // First-login race: if another request has already created the row, read it again.
  // Make sure of the admin role anyway (both racers are ensureAdminUser).
  const row = await getUserByEmail(DB, norm);
  if (row && row.role !== 'admin') {
    await DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('admin', row.id).run();
    row.role = 'admin';
  }
  return row || user;
}

/**
 * Demotes a global admin to 'client' (see admins.ts): per-project roles
 * remain on the memberships (a collab stays admin of their own sites).
 */
export async function demoteAdmin(DB: D1Database, userId: string): Promise<void> {
  await DB.prepare("UPDATE users SET role = 'client' WHERE id = ? AND role = 'admin'").bind(userId).run();
}

/** The global admins in the DB (for the cron pass, admins.syncAdmins). */
export async function listGlobalAdmins(DB: D1Database): Promise<User[]> {
  const { results } = await DB.prepare("SELECT * FROM users WHERE role = 'admin'").all<User>();
  return results;
}

/**
 * Per project: ensures a COLLABORATOR user (role 'collab'). Creates it if
 * missing, upgrades a 'client' to 'collab'. NEVER downgrades an 'admin' (a
 * global admin stays one). Scoping to sites is separate: the caller adds the
 * membership only to the projects chosen by the admin.
 */
export async function ensureCollabUser(
  DB: D1Database,
  email: string,
  name: string | null,
): Promise<User> {
  const norm = email.trim().toLowerCase();
  const existing = await getUserByEmail(DB, norm);
  if (existing) {
    if (existing.role === 'admin') return existing; // never demote the global admin
    if (existing.role !== 'collab') {
      await DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('collab', existing.id).run();
      existing.role = 'collab';
    }
    return existing;
  }
  const user: User = {
    id: crypto.randomUUID(),
    email: norm,
    role: 'collab',
    name,
    created_at: Date.now(),
  };
  await DB.prepare(
    'INSERT OR IGNORE INTO users (id, email, role, name, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(user.id, user.email, user.role, user.name, user.created_at)
    .run();
  return (await getUserByEmail(DB, norm)) || user;
}

/**
 * Revokes all of the user's sessions issued before `cutoff`.
 * The cutoff never moves back (MAX). Fail-open: if the table is missing
 * (migration 0003 not applied) it logs and returns false, without 500 errors.
 */
export async function revokeSessions(
  DB: D1Database,
  userId: string,
  cutoff: number = Date.now(),
): Promise<boolean> {
  try {
    await DB.prepare(
      `INSERT INTO session_revocations (user_id, revoked_before) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         revoked_before = MAX(session_revocations.revoked_before, excluded.revoked_before)`,
    )
      .bind(userId, cutoff)
      .run();
    return true;
  } catch (e) {
    console.log('[pinna] revokeSessions failed (fail-open):', (e as Error).message);
    return false;
  }
}

// --- Magic link ---------------------------------------------------------

// 90 minutes: a client who opens the email late (a meeting, a distraction)
// does not find it "expired". Single use + hashed + atomic consumption: a
// longer leak window, but a low risk.
const MAGIC_TTL_MS = 90 * 60 * 1000;

export async function createMagicLink(
  DB: D1Database,
  email: string,
  tokenHash: string,
  code?: string | null,
): Promise<void> {
  const now = Date.now();
  // The same row carries both the token (link, hashed) and the 6-digit OTP
  // code (in clear text: it is short, the defense is the attempt cap + the
  // 90-minute window, not secrecy at rest). `attempts` starts at 0
  // (column default).
  await DB.prepare(
    'INSERT INTO magic_links (token_hash, email, expires_at, used_at, code, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
  )
    .bind(tokenHash, email.trim().toLowerCase(), now + MAGIC_TTL_MS, code ?? null, now)
    .run();
}

/**
 * Email of a usable magic link (unused, not expired) WITHOUT consuming it: the
 * page behind the email link shows which account the link signs into.
 */
export async function peekMagicLink(
  DB: D1Database,
  tokenHash: string,
  now: number = Date.now(),
): Promise<string | null> {
  const row = await DB.prepare(
    'SELECT email FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?',
  )
    .bind(tokenHash, now)
    .first<{ email: string }>();
  return row ? row.email : null;
}

/** Consumes a magic link: returns the email if valid and unused, otherwise null. */
export async function consumeMagicLink(
  DB: D1Database,
  tokenHash: string,
): Promise<string | null> {
  const now = Date.now();
  // ATOMIC consumption: sets used_at only if the link is not already used and
  // not expired, and returns the email in the same statement (RETURNING). Two
  // concurrent verifies with the same token: only the one that actually
  // performs the UPDATE gets a row, the other gets null. No read-then-write race.
  const row = await DB.prepare(
    `UPDATE magic_links SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?
      RETURNING email`,
  )
    .bind(now, tokenHash, now)
    .first<{ email: string }>();
  if (!row) return null;
  await closeOtherLinks(DB, row.email, now);
  return row.email;
}

/**
 * Verifies a 6-digit OTP code. Returns the email if the code matches one of
 * that email's still valid magic links (unused, not expired, code not
 * disabled); otherwise null. Constant-time comparison (safeEqual), atomic
 * consumption (RETURNING on used_at still NULL).
 *
 * ATOMIC cap of 5 attempts: every attempt RESERVES its slot with a
 * conditional UPDATE (attempts < 5) BEFORE the comparison, so parallel
 * attempts cannot get around it.
 *
 * Only the LATEST code. Accepting the code of any open link would stop
 * someone who knows a client's email from invalidating the code the client
 * just received by requesting another one; but then every attempt would be
 * compared with ALL the open codes, and with N open codes every guess would
 * have N times the odds. So:
 *  - the code is compared only with the email's latest open link (the same
 *    one as latestOpenLink); the attempt is reserved on that row only;
 *  - the "I request another code and invalidate yours" attack does not apply,
 *    because /auth/request does not create a new code while the latest one
 *    is still valid;
 *  - all the LINKS stay valid (consumeMagicLink, 256-bit token);
 *  - once the attempts run out, the CODE is disabled (code = NULL), not the
 *    link: the email button (256-bit token, not guessable) still works;
 *  - after a successful sign-in all the other open links of the email are closed.
 *
 * Per-email cap: with 4 addresses one could get 10 codes an hour with 5
 * attempts each, 50 guesses an hour on 6 digits (about 35% in a year on a
 * known account). So beyond OTP_FAIL_PER_EMAIL wrong codes in the last 24
 * hours (sliding counter on rate_limits) the CODE is no longer valid for that
 * email, not even the right one; the email button stays valid. The slot is
 * reserved BEFORE the comparison (atomic even in a burst) and given back if
 * the code was right. Counting happens only when the email has open codes:
 * unknown emails write nothing, and the response (null) is the same in every
 * case, so it does not reveal whether the email exists.
 */
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_FAIL_PER_EMAIL = 20;
export const OTP_FAIL_SPAN = 86400;

export async function verifyOtp(
  DB: D1Database,
  email: string,
  code: string,
): Promise<string | null> {
  const now = Date.now();
  const norm = email.trim().toLowerCase();
  // Cap already full: no write at all (neither attempts nor counter).
  if (await peekSliding(DB, 'otp-fail', norm, OTP_FAIL_PER_EMAIL, OTP_FAIL_SPAN)) return null;
  // The attempt is reserved ONLY on the latest open link (same order as
  // latestOpenLink), in a single statement: atomic even in a burst.
  const { results } = await DB.prepare(
    `UPDATE magic_links SET attempts = attempts + 1
      WHERE token_hash = (
              SELECT token_hash FROM magic_links
               WHERE email = ? AND used_at IS NULL AND expires_at >= ?
               ORDER BY created_at DESC, rowid DESC LIMIT 1)
        AND code IS NOT NULL AND attempts < ?
      RETURNING token_hash, code`,
  )
    .bind(norm, now, OTP_MAX_ATTEMPTS)
    .all<{ token_hash: string; code: string | null }>();
  // Codes that reached the cap: disabled, the link stays clickable.
  await DB.prepare(
    `UPDATE magic_links SET code = NULL
      WHERE email = ? AND used_at IS NULL AND code IS NOT NULL AND attempts >= ?`,
  )
    .bind(norm, OTP_MAX_ATTEMPTS)
    .run();
  // No open code (unknown email or no codes): nothing to count.
  if (!results.length) return null;
  const slot = await consumeSliding(DB, 'otp-fail', norm, OTP_FAIL_PER_EMAIL, OTP_FAIL_SPAN);
  if (!slot.allowed) return null;
  let match: string | null = null;
  for (const r of results) {
    // At most one row (the latest link); constant-time comparison.
    if (r.code && safeEqual(r.code, code) && match === null) match = r.token_hash;
  }
  if (!match) return null;
  // The code was right: it does not count as a wrong code.
  await refundSliding(DB, 'otp-fail', norm, slot.win);
  const consumed = await DB.prepare(
    'UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING email',
  )
    .bind(now, match)
    .first<{ email: string }>();
  if (!consumed) return null;
  await closeOtherLinks(DB, consumed.email, now);
  return consumed.email;
}

/** The latest open link (unused, not expired) of an email. */
export interface OpenLink {
  token_hash: string;
  code: string | null;
  attempts: number;
  created_at: number;
}

/**
 * The email's latest open link, or null: /auth/request does not send a new
 * email while its code is still valid. Order: created_at, then insertion
 * order (rowid) on ties.
 */
export async function latestOpenLink(DB: D1Database, email: string, now: number = Date.now()): Promise<OpenLink | null> {
  return DB.prepare(
    `SELECT token_hash, code, attempts, created_at FROM magic_links
      WHERE email = ? AND used_at IS NULL AND expires_at >= ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(email.trim().toLowerCase(), now)
    .first<OpenLink>();
}

/** True if the code of the latest open link can still be used. */
export function openCodeUsable(link: OpenLink | null): boolean {
  return !!link && !!link.code && link.attempts < OTP_MAX_ATTEMPTS;
}

/**
 * The email with the link was not sent: the row just created is closed,
 * otherwise for 90 minutes /auth/request would find it as "code still valid"
 * and send nothing.
 */
export async function discardMagicLink(DB: D1Database, tokenHash: string, now: number = Date.now()): Promise<void> {
  await DB.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
    .bind(now, tokenHash)
    .run();
}

/** After a successful sign-in: the email's other open links and codes are no longer needed. */
export async function closeOtherLinks(DB: D1Database, email: string, now: number = Date.now()): Promise<void> {
  await DB.prepare('UPDATE magic_links SET used_at = ? WHERE email = ? AND used_at IS NULL')
    .bind(now, email.trim().toLowerCase())
    .run();
}

// --- Projects -----------------------------------------------------------

export async function getProject(DB: D1Database, id: string): Promise<Project | null> {
  return DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<Project>();
}

export async function getProjectBySlug(
  DB: D1Database,
  slug: string,
): Promise<Project | null> {
  return DB.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<Project>();
}

/** A user's effective role on a project (membership). */
export type ProjectRole = 'admin' | 'collab' | 'client';

/**
 * Projects visible to a user: all of them for a global admin, only their own
 * for everyone else. Every project carries `my_role`, the user's role ON THAT
 * project (the collab role is per project, not global).
 */
export async function listProjectsForUser(
  DB: D1Database,
  user: User,
): Promise<(Project & { my_role: ProjectRole })[]> {
  if (user.role === 'admin') {
    const { results } = await DB.prepare(
      'SELECT * FROM projects ORDER BY created_at DESC',
    ).all<Project>();
    return results.map((p) => ({ ...p, my_role: 'admin' as const }));
  }
  let results: (Project & { member_role: string | null })[];
  try {
    ({ results } = await DB.prepare(
      `SELECT p.*, m.role AS member_role FROM projects p
         JOIN memberships m ON m.project_id = p.id
        WHERE m.user_id = ?
        ORDER BY p.created_at DESC`,
    )
      .bind(user.id)
      .all<Project & { member_role: string | null }>());
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    logMissingRole('listProjectsForUser', e);
    ({ results } = await DB.prepare(
      `SELECT p.*, NULL AS member_role FROM projects p
         JOIN memberships m ON m.project_id = p.id
        WHERE m.user_id = ?
        ORDER BY p.created_at DESC`,
    )
      .bind(user.id)
      .all<Project & { member_role: string | null }>());
  }
  return results.map(({ member_role, ...p }) => ({
    ...p,
    my_role: member_role === 'collab' ? ('collab' as const) : ('client' as const),
  }));
}

/** All projects, most recent first. For the summary endpoint (/api/summary). */
export async function listAllProjects(DB: D1Database): Promise<Project[]> {
  const { results } = await DB.prepare(
    'SELECT * FROM projects ORDER BY created_at DESC',
  ).all<Project>();
  return results;
}

export async function createProject(
  DB: D1Database,
  name: string,
  stagingUrl: string,
): Promise<Project> {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (await getProjectBySlug(DB, slug)) slug = `${base}-${n++}`;
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    slug,
    staging_url: stagingUrl,
    created_at: Date.now(),
  };
  await DB.prepare(
    'INSERT INTO projects (id, name, slug, staging_url, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(project.id, project.name, project.slug, project.staging_url, project.created_at)
    .run();
  return project;
}

/** True if the user can see the project (a global admin always, a client if a member). */
export async function userCanAccess(
  DB: D1Database,
  user: User,
  projectId: string,
): Promise<boolean> {
  if (user.role === 'admin') return true;
  const row = await DB.prepare(
    'SELECT 1 FROM memberships WHERE user_id = ? AND project_id = ?',
  )
    .bind(user.id, projectId)
    .first();
  return row != null;
}

/**
 * The user's effective role on the project: 'admin' (global admin) everywhere,
 * otherwise the role of THEIR membership on that project ('collab' or
 * 'client'; NULL in old rows = client). null if not a member.
 */
export async function projectRole(
  DB: D1Database,
  user: User,
  projectId: string,
): Promise<ProjectRole | null> {
  if (user.role === 'admin') return 'admin';
  let row: { role: string | null } | null;
  try {
    row = await DB.prepare(
      'SELECT role FROM memberships WHERE user_id = ? AND project_id = ?',
    )
      .bind(user.id, projectId)
      .first<{ role: string | null }>();
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    logMissingRole('projectRole', e);
    return (await userCanAccess(DB, user, projectId)) ? 'client' : null;
  }
  if (!row) return null;
  return row.role === 'collab' ? 'collab' : 'client';
}

/**
 * Per project: True if the user can ADMINISTER the project (mark done, delete
 * other people's comments, invite clients).
 * A global admin everywhere; a collaborator ONLY where their membership has
 * role 'collab' (users.role 'collab' plus being a member is not enough: a
 * collab invited to a project as a plain client is a client there).
 */
export async function canAdmin(
  DB: D1Database,
  user: User,
  projectId: string,
): Promise<boolean> {
  const role = await projectRole(DB, user, projectId);
  return role === 'admin' || role === 'collab';
}

/**
 * Adds (or updates) the membership with its project role. An invite can only
 * RAISE the role (client -> collab), never lower it: a collab who invites
 * another collab of the same site as a client does not demote them.
 */
export async function addMembership(
  DB: D1Database,
  userId: string,
  projectId: string,
  role: 'client' | 'collab' = 'client',
): Promise<void> {
  try {
    await DB.prepare(
      `INSERT INTO memberships (user_id, project_id, created_at, role) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, project_id) DO UPDATE SET
         role = CASE WHEN excluded.role = 'collab' THEN 'collab' ELSE memberships.role END`,
    )
      .bind(userId, projectId, Date.now(), role)
      .run();
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    // Without the column the role cannot be saved: the membership is created
    // as 'client' (access yes, admin no). Redo it after migration 0002.
    logMissingRole('addMembership(' + role + ')', e);
    await DB.prepare('INSERT OR IGNORE INTO memberships (user_id, project_id, created_at) VALUES (?, ?, ?)')
      .bind(userId, projectId, Date.now())
      .run();
  }
}

/**
 * Removes a user's membership (and therefore their access to the project).
 * True if there was a membership to remove. The user's widget token stops
 * working right away (resolveUser checks the membership on every request),
 * and so does the proxy token on the pages.
 */
export async function removeMembership(
  DB: D1Database,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const r = await DB.prepare('DELETE FROM memberships WHERE user_id = ? AND project_id = ?')
    .bind(userId, projectId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Members of a project with their role (for administration). */
export async function listMembers(
  DB: D1Database,
  projectId: string,
): Promise<{ id: string; email: string; name: string | null; role: 'collab' | 'client' }[]> {
  let results: { id: string; email: string; name: string | null; member_role: string | null }[];
  try {
    ({ results } = await DB.prepare(
      `SELECT u.id, u.email, u.name, m.role AS member_role FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ? ORDER BY u.email`,
    )
      .bind(projectId)
      .all<{ id: string; email: string; name: string | null; member_role: string | null }>());
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    logMissingRole('listMembers', e);
    ({ results } = await DB.prepare(
      `SELECT u.id, u.email, u.name, NULL AS member_role FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.project_id = ? ORDER BY u.email`,
    )
      .bind(projectId)
      .all<{ id: string; email: string; name: string | null; member_role: string | null }>());
  }
  return results.map(({ member_role, ...u }) => ({
    ...u,
    role: member_role === 'collab' ? ('collab' as const) : ('client' as const),
  }));
}

/** Counts of open/done comments of a project (for the site list). */
export async function projectCounts(
  DB: D1Database,
  projectId: string,
): Promise<{ open: number; done: number }> {
  const { results } = await DB.prepare(
    `SELECT status, COUNT(*) AS n FROM comments
      WHERE project_id = ? AND parent_id IS NULL
      GROUP BY status`,
  )
    .bind(projectId)
    .all<{ status: string; n: number }>();
  let open = 0;
  let done = 0;
  for (const r of results) {
    if (r.status === 'done') done = r.n;
    else if (r.status === 'open') open = r.n;
    // unexpected statuses (none today: domain {open,done}) are ignored instead
    // of skewing the count of open ones.
  }
  return { open, done };
}

/**
 * Extended statistics of a project for an external dashboard:
 * - `open`/`done`: as in projectCounts
 * - `oldestOpenAt`: timestamp of the oldest open pin (null if none open)
 *   -> the dashboard shows "open for N days" to highlight comments that
 *   stall
 * - `avgResolveMs`: average (resolved_at - created_at) over done pins (null if
 *   none done) -> the dashboard shows "average resolution: N hours"
 */
export async function projectStats(
  DB: D1Database,
  projectId: string,
): Promise<{
  open: number;
  done: number;
  oldestOpenAt: number | null;
  avgResolveMs: number | null;
}> {
  const base = await projectCounts(DB, projectId);
  const oldest = await DB.prepare(
    `SELECT MIN(created_at) AS t FROM comments
      WHERE project_id = ? AND parent_id IS NULL AND status = 'open'`,
  )
    .bind(projectId)
    .first<{ t: number | null }>();
  const avg = await DB.prepare(
    `SELECT AVG(resolved_at - created_at) AS avg_ms FROM comments
      WHERE project_id = ? AND parent_id IS NULL
        AND status = 'done' AND resolved_at IS NOT NULL`,
  )
    .bind(projectId)
    .first<{ avg_ms: number | null }>();
  return {
    ...base,
    oldestOpenAt: oldest?.t ?? null,
    avgResolveMs: avg?.avg_ms != null ? Math.round(avg.avg_ms) : null,
  };
}

export interface ProjectStat {
  open: number;
  done: number;
  oldestOpenAt: number | null;
  avgResolveMs: number | null;
}

/**
 * N+1 fix: statistics of ALL projects in ONE aggregate query
 * (GROUP BY project_id) instead of calling projectStats per project. The
 * per-project version runs 3 queries per project (projectCounts + oldest + avg):
 * `/api/summary` would reach 1+3N and break the Workers free plan limit of 50
 * subrequests per invocation at ~17 projects. Here it stays at 2 queries in
 * total regardless of N. Same semantics as projectStats: top-level pins only
 * (parent_id IS NULL). Returns a Map projectId -> stat (projects without
 * comments are absent).
 */
export async function projectStatsBatch(DB: D1Database): Promise<Map<string, ProjectStat>> {
  const { results } = await DB.prepare(
    `SELECT project_id,
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
            MIN(CASE WHEN status = 'open' THEN created_at END) AS oldest_open_at,
            AVG(CASE WHEN status = 'done' AND resolved_at IS NOT NULL
                     THEN resolved_at - created_at END) AS avg_resolve_ms
       FROM comments
      WHERE parent_id IS NULL
      GROUP BY project_id`,
  ).all<{
    project_id: string;
    open: number | null;
    done: number | null;
    oldest_open_at: number | null;
    avg_resolve_ms: number | null;
  }>();
  const map = new Map<string, ProjectStat>();
  for (const r of results) {
    map.set(r.project_id, {
      open: r.open ?? 0,
      done: r.done ?? 0,
      oldestOpenAt: r.oldest_open_at ?? null,
      avgResolveMs: r.avg_resolve_ms != null ? Math.round(r.avg_resolve_ms) : null,
    });
  }
  return map;
}

// --- Comments -----------------------------------------------------------

/**
 * The comments of a project, with author_role = the author's role ON THIS
 * PROJECT ('admin' for a global admin, otherwise their membership role,
 * 'client' when they are no longer a member): the users' global roles are not
 * exposed to the project's members.
 */
export async function listComments(
  DB: D1Database,
  projectId: string,
): Promise<CommentRow[]> {
  return selectCommentRows(DB, 'c.project_id = ?', projectId, 'listComments');
}

/** One comment with its author_role on the project (as in listComments), or null. */
export async function getCommentRow(DB: D1Database, id: string): Promise<CommentRow | null> {
  return (await selectCommentRows(DB, 'c.id = ?', id, 'getCommentRow'))[0] ?? null;
}

async function selectCommentRows(
  DB: D1Database,
  where: 'c.project_id = ?' | 'c.id = ?',
  arg: string,
  caller: string,
): Promise<CommentRow[]> {
  const select = (role: string) =>
    DB.prepare(
      `SELECT c.*, ${role} AS author_role
         FROM comments c
         JOIN users u ON u.id = c.author_id
         LEFT JOIN memberships m ON m.user_id = c.author_id AND m.project_id = c.project_id
        WHERE ${where}
        ORDER BY c.created_at ASC`,
    )
      .bind(arg)
      .all<CommentRow>();
  try {
    return (await select("CASE WHEN u.role = 'admin' THEN 'admin' WHEN m.role = 'collab' THEN 'collab' ELSE 'client' END")).results;
  } catch (e) {
    // Without migration 0002 every membership counts as 'client' (projectRole).
    if (!isMissingSchema(e)) throw e;
    logMissingRole(caller, e);
    return (await select("CASE WHEN u.role = 'admin' THEN 'admin' ELSE 'client' END")).results;
  }
}

/** Characters of a comment row counted by the quota: text, page path and selector. */
const COMMENT_CHARS_SQL = "LENGTH(body) + LENGTH(COALESCE(page_path, '')) + LENGTH(COALESCE(anchor_selector, ''))";

/**
 * Characters taken up by a project's comments (quota): text, page path and
 * selector (not just the text, since path and selector are stored too).
 */
export async function projectCommentChars(DB: D1Database, projectId: string): Promise<number> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(${COMMENT_CHARS_SQL}), 0) AS n
       FROM comments WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getComment(DB: D1Database, id: string): Promise<Comment | null> {
  return DB.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first<Comment>();
}

/**
 * Inserts a comment. With `maxChars` the project's character quota is part of
 * the INSERT itself (INSERT ... SELECT ... WHERE): requests sent in parallel
 * cannot all pass a check made before the write. Null = over the quota, nothing
 * written.
 */
export async function createComment(
  DB: D1Database,
  projectId: string,
  authorId: string,
  input: NewCommentInput,
  maxChars?: number,
): Promise<Comment | null> {
  const c: Comment = {
    id: crypto.randomUUID(),
    project_id: projectId,
    parent_id: input.parent_id ?? null,
    page_path: input.page_path ?? '',
    anchor_selector: input.anchor_selector ?? null,
    anchor_x: input.anchor_x ?? null,
    anchor_y: input.anchor_y ?? null,
    page_x: input.page_x ?? null,
    page_y: input.page_y ?? null,
    viewport_w: input.viewport_w ?? null,
    viewport: input.viewport ?? null,
    body: input.body.trim(),
    author_id: authorId,
    status: 'open',
    created_at: Date.now(),
    resolved_at: null,
  };
  const values = [
    c.id,
    c.project_id,
    c.parent_id,
    c.page_path,
    c.anchor_selector,
    c.anchor_x,
    c.anchor_y,
    c.page_x,
    c.page_y,
    c.viewport_w,
    c.viewport,
    c.body,
    c.author_id,
    c.status,
    c.created_at,
    c.resolved_at,
  ];
  const cols = `(id, project_id, parent_id, page_path, anchor_selector,
        anchor_x, anchor_y, page_x, page_y, viewport_w, viewport,
        body, author_id, status, created_at, resolved_at)`;
  if (maxChars === undefined) {
    await DB.prepare(`INSERT INTO comments ${cols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...values)
      .run();
    return c;
  }
  const res = await DB.prepare(
    `INSERT INTO comments ${cols}
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COALESCE(SUM(${COMMENT_CHARS_SQL}), 0) FROM comments WHERE project_id = ?)
            + LENGTH(?) + LENGTH(COALESCE(?, '')) + LENGTH(COALESCE(?, '')) <= ?`,
  )
    .bind(...values, projectId, c.body, c.page_path, c.anchor_selector, maxChars)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? c : null;
}

/**
 * Updates status and/or text. With `maxChars` a longer text must fit the
 * project's character quota, checked inside the UPDATE itself (sum - old
 * length + new length): parallel edits cannot all pass a check made before the
 * write. A text that does not grow always passes. Null = no such comment,
 * 'over-quota' = nothing written.
 */
export async function updateComment(
  DB: D1Database,
  id: string,
  patch: { status?: string; body?: string },
  maxChars?: number,
): Promise<Comment | null | 'over-quota'> {
  const cur = await getComment(DB, id);
  if (!cur) return null;
  const status: 'open' | 'done' =
    patch.status === 'open' || patch.status === 'done' ? patch.status : cur.status;
  const body =
    typeof patch.body === 'string' && patch.body.trim() ? patch.body.trim() : cur.body;
  const resolved_at = status === 'done' ? cur.resolved_at ?? Date.now() : null;
  // Nothing to change: no write.
  if (status === cur.status && body === cur.body && resolved_at === (cur.resolved_at ?? null)) return cur;
  if (maxChars === undefined) {
    await DB.prepare('UPDATE comments SET status = ?, body = ?, resolved_at = ? WHERE id = ?')
      .bind(status, body, resolved_at, id)
      .run();
    return { ...cur, status, body, resolved_at };
  }
  const res = await DB.prepare(
    `UPDATE comments SET status = ?, body = ?, resolved_at = ?
      WHERE id = ?
        AND (LENGTH(?) <= LENGTH(body)
             OR (SELECT COALESCE(SUM(${COMMENT_CHARS_SQL}), 0) FROM comments WHERE project_id = ?)
                - LENGTH(body) + LENGTH(?) <= ?)`,
  )
    .bind(status, body, resolved_at, id, body, cur.project_id, body, maxChars)
    .run();
  if ((res.meta?.changes ?? 0) > 0) return { ...cur, status, body, resolved_at };
  return (await getComment(DB, id)) ? 'over-quota' : null;
}

/**
 * Deletes a comment (and its replies) with their attachments.
 * Returns the R2 keys of the files to remove from the bucket.
 *
 * INVARIANT: a thread is at most 1 level deep (pin -> reply), never
 * reply-of-reply. Guaranteed upstream by createComment (POST /api/comments
 * rejects a parent_id that is not a top-level comment of the same project).
 * That is why the 1-level cascade below is complete and leaves no orphans.
 */
const COMMENT_ATT_SCOPE =
  'comment_id = ? OR comment_id IN (SELECT id FROM comments WHERE parent_id = ?)';

/**
 * R2 keys of the attachments of a comment and its replies. The caller deletes
 * the blobs FIRST (deleteR2InBatches) and calls deleteCommentRows only if R2
 * confirms (otherwise the rows would disappear even when R2 failed).
 */
export async function commentAttachmentKeys(DB: D1Database, id: string): Promise<string[]> {
  const { results } = await DB.prepare(`SELECT r2_key FROM attachments WHERE ${COMMENT_ATT_SCOPE}`)
    .bind(id, id)
    .all<{ r2_key: string }>();
  return results.map((r) => r.r2_key);
}

/**
 * True if deleting the comment would also delete work of someone other than
 * `authorId`: deleting a pin deletes its whole thread (deleteCommentRows), so a
 * reply written by another user, or a file in the thread uploaded by another
 * user, would go with it. An attachment with no recorded uploader (created_by
 * NULL, legacy rows) counts as someone else's: not provably the author's.
 */
export async function threadHasOthersWork(DB: D1Database, id: string, authorId: string): Promise<boolean> {
  const reply = await DB.prepare('SELECT 1 AS x FROM comments WHERE parent_id = ? AND author_id != ? LIMIT 1')
    .bind(id, authorId)
    .first();
  if (reply) return true;
  const att = await DB.prepare(`SELECT 1 AS x FROM attachments WHERE (${COMMENT_ATT_SCOPE}) AND created_by IS NOT ? LIMIT 1`)
    .bind(id, id, authorId)
    .first();
  return !!att;
}

/** Removes the comment, its replies and their attachments from D1. */
export async function deleteCommentRows(DB: D1Database, id: string): Promise<void> {
  await DB.prepare(`DELETE FROM attachments WHERE ${COMMENT_ATT_SCOPE}`).bind(id, id).run();
  await DB.prepare('DELETE FROM comments WHERE id = ? OR parent_id = ?').bind(id, id).run();
}

// --- Notifications ------------------------------------------------------

/**
 * Recipients of a notification: the other side of the project relative to the author.
 * Per-project notification scoping:
 * - comment by a CLIENT -> notifies the project TEAM: the global admins
 *   (who receive everything) + the collaborators who are MEMBERS of that
 *   project (only on their own sites). So a collab does not receive the
 *   emails of sites not assigned to them.
 * - comment by the TEAM (admin/collab) -> notifies the project's CLIENT members.
 */
export async function listNotifyRecipients(
  DB: D1Database,
  projectId: string,
  actorRole: string,
): Promise<User[]> {
  // actorRole = EFFECTIVE role on the project (projectRole); recipients are
  // chosen by the membership role, not by users.role.
  try {
    if (actorRole === 'client') {
      const { results } = await DB.prepare(
        `SELECT * FROM users WHERE role = 'admin'
         UNION
         SELECT u.* FROM users u
           JOIN memberships m ON m.user_id = u.id
          WHERE m.role = 'collab' AND m.project_id = ? AND u.role != 'admin'`,
      )
        .bind(projectId)
        .all<User>();
      return results;
    }
    const { results } = await DB.prepare(
      `SELECT u.* FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE m.project_id = ? AND COALESCE(m.role, 'client') = 'client' AND u.role != 'admin'`,
    )
      .bind(projectId)
      .all<User>();
    return results;
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    logMissingRole('listNotifyRecipients', e);
    // All members are 'client': only the global admins go to the team, all members to the clients.
    const sql =
      actorRole === 'client'
        ? "SELECT * FROM users WHERE role = 'admin'"
        : `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
            WHERE m.project_id = ? AND u.role != 'admin'`;
    const stmt = DB.prepare(sql);
    const { results } = await (actorRole === 'client' ? stmt : stmt.bind(projectId)).all<User>();
    return results;
  }
}

/** True if the user has muted notifications. */
export async function isMuted(DB: D1Database, userId: string): Promise<boolean> {
  const row = await DB.prepare('SELECT muted FROM notification_prefs WHERE user_id = ?')
    .bind(userId)
    .first<{ muted: number }>();
  return !!row && row.muted === 1;
}

/**
 * Sets the user's notification preference. If the value is already the same
 * (no row = not muted) it writes nothing.
 */
export async function setMuted(
  DB: D1Database,
  userId: string,
  muted: boolean,
): Promise<void> {
  if ((await isMuted(DB, userId)) === muted) return;
  await DB.prepare(
    `INSERT INTO notification_prefs (user_id, muted) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET muted = excluded.muted`,
  )
    .bind(userId, muted ? 1 : 0)
    .run();
}

/**
 * True if we may send the user a notification for the project. It avoids
 * sending one email per comment: after a send it stays quiet for
 * `cooldownMs`. When it allows a send it updates the state.
 */
export async function shouldNotify(
  DB: D1Database,
  userId: string,
  projectId: string,
  cooldownMs: number,
): Promise<boolean> {
  const now = Date.now();
  const threshold = now - cooldownMs;
  // ATOMIC conditional upsert: allows the send (changes > 0) only if the row
  // does not exist yet (INSERT) or if the last send is beyond the cooldown
  // (DO UPDATE ... WHERE). Within the cooldown the WHERE is false: 0 rows
  // touched -> no send. No read-then-write: two concurrent notifyEvent calls
  // cannot both get through (single statement).
  const res = await DB.prepare(
    `INSERT INTO notify_state (user_id, project_id, last_sent) VALUES (?, ?, ?)
     ON CONFLICT(user_id, project_id) DO UPDATE SET last_sent = excluded.last_sent
       WHERE notify_state.last_sent <= ?`,
  )
    .bind(userId, projectId, now, threshold)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Inert query with a cost equivalent to the D1 writes of the "email exists"
 * branch in /api/auth/request. Combined with a random delay in the handler,
 * it evens out the response timing and prevents email enumeration via a
 * client-side stopwatch.
 */
export async function dummyAuthDelay(DB: D1Database): Promise<void> {
  try {
    // Inert SELECT: simulates the I/O cost of a DB round trip equivalent to
    // createMagicLink (which is an INSERT). D1 prepared statement + bind +
    // run time is in the ms range, comparable.
    await DB.prepare("SELECT 1 AS k WHERE 1 = 0").first();
  } catch {
    // Never block the auth flow because of errors in a dummy query.
  }
}

// --- Admin audit --------------------------------------------------------

/**
 * Records an admin authentication attempt (both OK and failed). One
 * row = one hit. So we can inspect AFTER a suspected leak of the
 * ADMIN_KEY (e.g. many failed attempts from new IPs).
 */
/**
 * Maximum lengths in admin_audit: otherwise the User-Agent would be stored
 * whole, up to about 32 KB per row, chosen by whoever tries the key.
 */
export const ADMIN_AUDIT_UA_MAX = 200;
const ADMIN_AUDIT_IP_MAX = 64;

export async function logAdminEntry(
  DB: D1Database,
  endpoint: 'entra' | 'summary',
  via: 'header' | 'query' | 'body',
  ok: boolean,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  try {
    await DB.prepare(
      `INSERT INTO admin_audit (id, endpoint, via, ok, ip, ua, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        endpoint,
        via,
        ok ? 1 : 0,
        ip ? ip.slice(0, ADMIN_AUDIT_IP_MAX) : null,
        ua ? ua.slice(0, ADMIN_AUDIT_UA_MAX) : null,
        Date.now(),
      )
      .run();
  } catch (e) {
    // The audit log must never block the flow: on error, log and continue.
    console.log('[pinna] admin_audit insert failed:', (e as Error).message);
  }
}

// --- Attachments --------------------------------------------------------

export async function createAttachment(
  DB: D1Database,
  a: {
    id: string;
    project_id: string;
    r2_key: string;
    filename: string;
    content_type: string;
    size: number;
    /** users.id of the uploader (confused-deputy fix). */
    created_by: string;
  },
  limits?: { maxCount: number; maxBytes: number },
): Promise<Attachment | null> {
  const att: Attachment = { ...a, comment_id: null, created_at: Date.now() };
  const values = [
    att.id, att.comment_id, att.project_id, att.r2_key,
    att.filename, att.content_type, att.size, att.created_at, att.created_by,
  ];
  const cols = '(id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by)';
  if (!limits) {
    await DB.prepare(`INSERT INTO attachments ${cols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...values)
      .run();
    return att;
  }
  // The project's quotas (number of files, bytes) inside the INSERT itself:
  // uploads or screenshots sent in parallel cannot all pass a check made
  // before the write. Null = over a quota, nothing written.
  const res = await DB.prepare(
    `INSERT INTO attachments ${cols}
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) < ? AND COALESCE(SUM(size), 0) + ? <= ? FROM attachments WHERE project_id = ?)`,
  )
    .bind(...values, limits.maxCount, att.size, limits.maxBytes, att.project_id)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? att : null;
}

export async function getAttachment(DB: D1Database, id: string): Promise<Attachment | null> {
  return DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<Attachment>();
}

/**
 * Deletes a single attachment (D1 record). The caller runs the authorization
 * checks FIRST (getAttachment + created_by/canAdmin gate) and THEN deletes the
 * R2 blob with the r2_key it already holds. Returns how many rows were deleted
 * (0 if the id does not exist, e.g. a double click).
 */
export async function deleteAttachment(DB: D1Database, id: string): Promise<number> {
  const res = await DB.prepare('DELETE FROM attachments WHERE id = ?').bind(id).run();
  return res.meta?.changes ?? 0;
}

/**
 * How long an unlinked upload (a draft: comment_id NULL) is kept. The nightly
 * sweep (purgeRetention) deletes older drafts, and linkAttachments refuses
 * them: a draft the sweep may be deleting is never linked to a comment (it
 * would end up as a row without its file).
 */
export const DRAFT_TTL_MS = 24 * 3600000;

/**
 * Links orphan attachments to a comment. Filters by (project_id, created_by,
 * comment_id IS NULL): only your own attachments in the same project can be
 * linked. Drafts older than DRAFT_TTL_MS are not linked (see there). This closes the confused-deputy hole (member A cannot link
 * attachments uploaded by member B into their own comments).
 *
 * Backward compatibility: for attachments created before the migration
 * (created_by NULL), the check fails and they cannot be linked. A reasonable
 * trade-off (few historical orphan attachments, no privilege regression).
 */
export async function linkAttachments(
  DB: D1Database,
  commentId: string,
  projectId: string,
  authorId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  // Returns how many attachments were actually linked: the caller compares it
  // with ids.length to notice (and report) if something was not linked
  // (invalid id / already linked / another uploader / another project).
  const res = await DB.prepare(
    `UPDATE attachments SET comment_id = ?
      WHERE comment_id IS NULL
        AND project_id = ?
        AND created_by = ?
        AND created_at >= ?
        AND id IN (${ph})`,
  )
    .bind(commentId, projectId, authorId, Date.now() - DRAFT_TTL_MS, ...ids)
    .run();
  return res.meta?.changes ?? 0;
}

/** Bytes taken up by a project's attachments (drafts included), for the quota. */
export async function projectAttachmentBytes(DB: D1Database, projectId: string): Promise<number> {
  return (await projectAttachmentUsage(DB, projectId)).bytes;
}

/** Bytes and number of a project's attachments (drafts included), for the quotas. */
export async function projectAttachmentUsage(DB: D1Database, projectId: string): Promise<{ bytes: number; count: number }> {
  const row = await DB.prepare('SELECT COALESCE(SUM(size), 0) AS b, COUNT(*) AS n FROM attachments WHERE project_id = ?')
    .bind(projectId)
    .first<{ b: number; n: number }>();
  return { bytes: Number(row?.b ?? 0), count: Number(row?.n ?? 0) };
}

/** The attachments linked to one comment. */
export async function listAttachmentsForComment(DB: D1Database, commentId: string): Promise<Attachment[]> {
  const { results } = await DB.prepare('SELECT * FROM attachments WHERE comment_id = ?')
    .bind(commentId)
    .all<Attachment>();
  return results;
}

/** A project's attachments already linked to a comment. */
export async function listAttachmentsForProject(
  DB: D1Database,
  projectId: string,
): Promise<Attachment[]> {
  const { results } = await DB.prepare(
    'SELECT * FROM attachments WHERE project_id = ? AND comment_id IS NOT NULL',
  )
    .bind(projectId)
    .all<Attachment>();
  return results;
}

/**
 * GDPR retention. Called by the Cron Trigger (wrangler.toml [triggers]).
 * - magic_links: they contain the email in clear text -> deleted 7 days after
 *   expiry (minimal window for debugging). They are the most exposed personal data.
 * - admin_audit: logged IP/UA -> 90-day retention.
 * Returns the deleted counts, for the scheduled handler's logging.
 */
export async function purgeRetention(
  DB: D1Database,
): Promise<{ magicLinks: number; auditRows: number; orphanKeys: string[] }> {
  // The rows of orphan attachments are NOT deleted here: the caller first
  // deletes the R2 blobs in batches and then, batch by batch, the rows with
  // deleteOrphanRows. If R2 fails the rows remain and the cron retries.
  const now = Date.now();
  const ml = await DB.prepare('DELETE FROM magic_links WHERE expires_at < ?')
    .bind(now - 7 * 86400000)
    .run();
  const au = await DB.prepare('DELETE FROM admin_audit WHERE created_at < ?')
    .bind(now - 90 * 86400000)
    .run();
  // Sweep of ORPHAN attachments: uploads started (R2 blob + D1 row with
  // comment_id NULL) but the comment was never sent (abandoned draft / X on the
  // draft / composer closed). Without the sweep they would stay forever (GDPR
  // risk + R2 cost). 24h grace so drafts in progress are not touched. The
  // caller (scheduled) deletes the R2 blobs with the returned keys.
  const orphanCutoff = now - DRAFT_TTL_MS;
  const { results } = await DB.prepare(
    'SELECT r2_key FROM attachments WHERE comment_id IS NULL AND created_at < ?',
  )
    .bind(orphanCutoff)
    .all<{ r2_key: string }>();
  const orphanKeys = results.map((r) => r.r2_key);
  return { magicLinks: ml.meta?.changes ?? 0, auditRows: au.meta?.changes ?? 0, orphanKeys };
}

/**
 * Removes the rows of orphan attachments whose R2 blobs have already been
 * deleted. In groups of 90 keys (D1 accepts at most 100 parameters per
 * query); only rows that are still orphans (comment_id NULL).
 */
export async function deleteOrphanRows(DB: D1Database, keys: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const ph = chunk.map(() => '?').join(',');
    const r = await DB.prepare(`DELETE FROM attachments WHERE comment_id IS NULL AND r2_key IN (${ph})`)
      .bind(...chunk)
      .run();
    n += r.meta?.changes ?? 0;
  }
  return n;
}
