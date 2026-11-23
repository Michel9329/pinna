/** Pinna - shared Worker types. */

/** Worker bindings (see wrangler.toml). */
export interface Env {
  DB: D1Database;
  /** Static assets of the Pinna app (Vue build, see wrangler.toml [assets]). */
  ASSETS: Fetcher;
  /** Secret used to sign sessions (wrangler secret put SESSION_SECRET). */
  SESSION_SECRET: string;
  /** Resend API key for sending email. Missing (outside dev mode) =
   *  /api/auth/request answers 503 "email not configured". */
  RESEND_API_KEY?: string;
  /**
   * Dev mode: "1" = without RESEND_API_KEY, /api/auth/request returns the
   * link and the code in the response, but ONLY on localhost/127.0.0.1. Set it
   * only in .dev.vars, never in production (where it never triggers anyway).
   */
  PINNA_DEV_MODE?: string;
  /** Sender of the emails (default onboarding@resend.dev). */
  PINNA_FROM_EMAIL?: string;
  /**
   * Cap on emails sent in the last 24 hours, sign-in and notifications
   * together (default 80, notify.ts EMAIL_DAILY_CAP_DEFAULT). The Resend free
   * plan allows about 100 a day: the margin is left to alerts, which do not count.
   */
  PINNA_EMAIL_DAILY_CAP?: string;
  /** Secret key for the admin entry (/entra#k=) and the X-Admin-Key header of /api/summary. */
  ADMIN_KEY?: string;
  /**
   * Allowlist of GLOBAL admin emails (CSV). Whoever signs in with a listed
   * email gets role 'admin' = sees and administers ALL projects. Meant only
   * for a second, truly global admin (e.g. a full partner).
   *
   * WARNING: do NOT use it for a collaborator scoped to specific sites: it
   * would make them a global admin, defeating per-project scoping, and
   * ensureCollabUser would NOT demote them (a global admin is never downgraded).
   * For a collaborator use the 'collab' invite (the add-collaborator button in
   * the project).
   * Set it via `wrangler secret put ADMIN_EMAILS`.
   */
  ADMIN_EMAILS?: string;
  /** R2 bucket for comment attachments. */
  ATTACHMENTS: R2Bucket;
  /**
   * KV: only the alert counters (alerts.ts). Request limits live in D1
   * (rate_limits table) and in the ANON_RL binding.
   */
  RATE_LIMIT: KVNamespace;
  /**
   * Workers Rate Limiting binding ([[ratelimits]] in wrangler.toml): shield
   * for the anonymous routes, counts in memory without writing to storage.
   * Optional: without it, rate-limit.ts falls back to the D1 counter with the
   * same threshold.
   */
  ANON_RL?: RateLimit;
  /**
   * Rate Limiting binding per authenticated user: shield, key = user id,
   * before every route that writes (rate-limit.ts userShield). Optional:
   * without it, an in-memory counter in the isolate.
   */
  USER_RL?: RateLimit;
  /** Cloudflare Browser Run (formerly Browser Rendering): headless Chrome for the real server-side
   *  screenshot. [browser] binding in wrangler.toml. */
  BROWSER?: Fetcher;
  /**
   * Recipient of operational alerts: spikes of Resend/screenshot/5xx errors
   * plus the daily digest. No fallback: if missing, alerts are not sent (the
   * counters remain). Set it via `wrangler secret put ALERT_EMAIL` or as
   * [vars] in wrangler.toml.
   */
  ALERT_EMAIL?: string;
  /**
   * Public address of Pinna (e.g. https://pinna.example.com), for the links and
   * the logo in emails. If missing, the request origin is used. See
   * config.publicOrigin.
   */
  PINNA_PUBLIC_URL?: string;
  /**
   * Origins from which /shot may load images, CSS, fonts and media besides the
   * staging site, comma-separated, e.g. "https://cdn.sanity.io".
   * Empty = staging only (CDN assets are missing from the screenshot).
   */
  PINNA_SHOT_ASSET_ORIGINS?: string;
  /**
   * The /_proxy proxy is off for security reasons: pages served by the proxy
   * ran on Pinna's origin (third-party scripts with the user's session). Turn
   * it back on with "1" only once that is fixed (sandbox + staging only).
   */
  PINNA_PROXY_ENABLED?: string;
}

/**
 * A user: a global admin, a client (reviewer scoped to their own projects) or
 * a collaborator (per project: full admin ONLY on the projects they are a
 * member of). 'collab' sees and administers only their own sites; scoping is
 * done via memberships.
 */
export interface User {
  id: string;
  email: string;
  role: 'admin' | 'client' | 'collab';
  name: string | null;
  created_at: number;
}

/** A client site on staging. */
export interface Project {
  id: string;
  name: string;
  slug: string;
  staging_url: string;
  created_at: number;
}

/** A pin (parent_id null) or a reply. */
export interface Comment {
  id: string;
  project_id: string;
  parent_id: string | null;
  page_path: string;
  anchor_selector: string | null;
  anchor_x: number | null;
  anchor_y: number | null;
  page_x: number | null;
  page_y: number | null;
  viewport_w: number | null;
  /** Viewport the pin was created in: 'desktop' | 'tablet' | 'mobile'. */
  viewport: string | null;
  body: string;
  author_id: string;
  status: 'open' | 'done';
  created_at: number;
  resolved_at: number | null;
}

/** Payload to create a comment. */
export interface NewCommentInput {
  parent_id?: string | null;
  page_path?: string;
  anchor_selector?: string | null;
  anchor_x?: number | null;
  anchor_y?: number | null;
  page_x?: number | null;
  page_y?: number | null;
  viewport_w?: number | null;
  viewport?: string | null;
  attachment_ids?: string[];
  body: string;
}

/** A comment attachment: the file lives on R2, its metadata here. */
export interface Attachment {
  id: string;
  comment_id: string | null;
  project_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: number;
  /** users.id of the uploader (confused-deputy fix). NULL for attachments
   *  created before the migration (backward compatibility). */
  created_by: string | null;
}
