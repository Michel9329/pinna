-- 0001_init: baseline schema of the versioned migrations.
-- Everything is CREATE TABLE / CREATE INDEX IF NOT EXISTS, so the migration is
-- idempotent. Apply with: bun run db:migrate (remote) / bun run db:migrate:local.
-- The OTP columns (magic_links.code/attempts) are part of the CREATE.

-- Pinna - D1 schema (multi-tenant + magic link auth)
--
-- REFERENTIAL INTEGRITY: enforced by the application. D1 does not enable
-- PRAGMA foreign_keys by default, so no FOREIGN KEY is declared (it would be
-- inert). Every write goes through the Worker and consistency (cascades, valid
-- parent_id, etc.) is guaranteed by the code (db.ts + index.ts handlers).
-- If a delete-project endpoint is ever exposed, implement the full manual
-- cascade (comments + attachments + R2 keys + memberships + notify_state +
-- notification_prefs) following deleteComment.

-- Users: global admins (role 'admin', see everything) + collaborators (role
-- 'collab': admin ONLY on the projects they are a member of) + clients
-- (role 'client'). Scoping of collab and client = via memberships.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'client',   -- 'admin' | 'collab' | 'client'
  name        TEXT,
  created_at  INTEGER NOT NULL
);

-- A project = a client site on staging (e.g. a *.pages.dev deploy).
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  staging_url  TEXT NOT NULL DEFAULT '',   -- URL of the staging site
  created_at   INTEGER NOT NULL
);

-- Membership: which users see which projects.
-- A global admin sees everything by role, no row needed.
CREATE TABLE IF NOT EXISTS memberships (
  user_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

-- Magic link: single-use token for passwordless sign-in.
-- The same row ALSO carries a 6-digit OTP code. A non-technical client TYPES
-- it in their own browser instead of opening the link from the mail app's
-- in-app browser (where the cookie lands in a throwaway jar, so they come back
-- signed out). This way the cookie lands in the browser they actually use.
-- `attempts` = wrong attempts, locked at 5 (brute-force guard for a 6-digit
-- code).
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash  TEXT PRIMARY KEY,    -- SHA-256 of the token (never the plain token)
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  code        TEXT,                          -- 6-digit OTP
  attempts    INTEGER NOT NULL DEFAULT 0,    -- wrong code attempts; locked at 5
  created_at  INTEGER NOT NULL
);

-- A comment = a top-level pin (parent_id NULL) or a reply.
CREATE TABLE IF NOT EXISTS comments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  parent_id       TEXT,                -- NULL = pin, set = reply
  page_path       TEXT NOT NULL DEFAULT '',
  anchor_selector TEXT,
  anchor_x        REAL,
  anchor_y        REAL,
  page_x          REAL,
  page_y          REAL,
  viewport_w      INTEGER,
  viewport        TEXT,                -- 'desktop' | 'tablet' | 'mobile'
  body            TEXT NOT NULL,
  author_id       TEXT NOT NULL,       -- users.id
  status          TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'done'
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);

-- Web Push subscriptions.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Notification preferences per user.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id  TEXT PRIMARY KEY,
  muted    INTEGER NOT NULL DEFAULT 0
);

-- Comment attachments: the file lives on R2, the metadata here.
-- created_by (confused-deputy guard): linkAttachments also filters on
-- author_id == created_by, so member A cannot link member B's attachments to
-- their own comments (same project, different authors).
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  comment_id    TEXT,                 -- NULL until the comment is created
  project_id    TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT                  -- users.id of the uploader; NULL on legacy rows
);

-- Notification anti-flood: last email sent per user + project.
CREATE TABLE IF NOT EXISTS notify_state (
  user_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  last_sent   INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

-- Audit trail of ADMIN_KEY use.
-- One row per hit on /entra or /api/summary, so unusual use (new IPs, high
-- frequency) can be spotted after the fact.
CREATE TABLE IF NOT EXISTS admin_audit (
  id          TEXT PRIMARY KEY,
  endpoint    TEXT NOT NULL,    -- 'entra' | 'summary'
  via         TEXT NOT NULL,    -- 'header' | 'query'
  ok          INTEGER NOT NULL, -- 0 = invalid key, 1 = OK
  ip          TEXT,
  ua          TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_project ON comments (project_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments (parent_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user    ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_project ON memberships (project_id);
CREATE INDEX IF NOT EXISTS idx_magic_email      ON magic_links (email);
CREATE INDEX IF NOT EXISTS idx_push_user        ON push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_att_comment      ON attachments (comment_id);
CREATE INDEX IF NOT EXISTS idx_att_project      ON attachments (project_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit (created_at DESC);

-- No default user: the first admin comes from ADMIN_EMAILS at the first
-- sign-in (see README, "First admin").
