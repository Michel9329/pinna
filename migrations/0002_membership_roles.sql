-- 0002_membership_roles: role PER PROJECT on memberships.
--
-- With the 'collab' role only on users.role it would be GLOBAL: a collaborator
-- invited as a plain client on another project would become its admin
-- (canAdmin would look at users.role + "is a member"). The role lives on the
-- membership instead: 'collab' = admin of THAT project, 'client' (or NULL, on
-- older rows) = reviewer.
--
-- Migration rule (wrangler.toml): additive, nullable ALTER, no table rebuild.
-- Apply BEFORE deploying the Worker that uses it.
ALTER TABLE memberships ADD COLUMN role TEXT DEFAULT 'client';

-- Existing data, without losing access: a user whose global role is 'collab'
-- was admin on ALL the projects they are a member of, so all their memberships
-- become 'collab' (same power as before). The others stay 'client' (default).
UPDATE memberships SET role = 'collab'
 WHERE user_id IN (SELECT id FROM users WHERE role = 'collab');
