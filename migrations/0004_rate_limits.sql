-- 0004_rate_limits: request-limit counters on D1.
--
-- Limits kept on KV would need a separate read and write (a parallel burst
-- gets through entirely) and one KV write for EVERY request, anonymous ones
-- included (free quota of 1,000 a day, then everything fails open). Here there
-- is one row per (rule:key, window start) and a single
--   INSERT ... ON CONFLICT(k, win) DO UPDATE SET n = n + excluded.n RETURNING n
-- that increments and reads in one atomic step (see worker/rate-limit.ts).
-- The daily cron removes windows closed for more than 2 days.
--
-- Only CREATE TABLE IF NOT EXISTS: no existing data touched. If the table is
-- missing the Worker skips the limits with an error in the logs (no 500).
CREATE TABLE IF NOT EXISTS rate_limits (
  k    TEXT NOT NULL,     -- "<rule>:<key>" (e.g. "shot-user:u_123")
  win  INTEGER NOT NULL,  -- window start, epoch seconds
  n    INTEGER NOT NULL,  -- requests (or bytes) counted in the window
  PRIMARY KEY (k, win)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_rate_limits_win ON rate_limits(win);
