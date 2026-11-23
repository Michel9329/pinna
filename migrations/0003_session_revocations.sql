-- 0003_session_revocations: per-user session revocation.
--
-- Sessions are stateless signed cookies (30 days), which on their own cannot
-- be revoked. Every session carries `iat` (ms) and readSession rejects it if
-- iat < the user's revoked_before. Logout records the cutoff (signs out of ALL
-- devices), and a global admin can sign a user out with
-- POST /api/users/:id/revoke-sessions. If the table is missing the Worker
-- fails open (no lockout because of an infrastructure problem).
--
-- Only CREATE TABLE IF NOT EXISTS: no existing data touched.
CREATE TABLE IF NOT EXISTS session_revocations (
  user_id         TEXT PRIMARY KEY,
  revoked_before  INTEGER NOT NULL   -- epoch ms: sessions issued before this = invalid
);
