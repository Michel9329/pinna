/**
 * Pinna - e2e, MADE-UP sample data. No real person or company: domain
 * example.test (reserved, it does not exist).
 *
 * Each browser has its own users and its own comment to resolve: the three
 * Playwright projects (chromium, firefox, webkit) run one after the other on
 * the same D1, and the sign-in email limits (3 an hour per email and address)
 * must not add up from one browser to the next.
 */
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

export const ADMIN = {
  id: 'u_e2e_admin',
  email: 'admin@example.test',
  name: 'Example Admin',
  // Made up, at least 32 characters (MIN_SECRET_LEN in worker/config.ts).
  key: 'made-up-e2e-admin-key-0123456789abcdef',
  sessionSecret: 'made-up-e2e-session-secret-0123456789abcdef',
};

export const PROJECT = {
  id: 'p_e2e',
  name: 'Acme Test Site',
  slug: 'acme-test-site',
};

/** Sample clients, one per test (a, b, d, f) plus the author of the comment in (e). */
export const CLIENT_KINDS = ['link', 'code', 'widget', 'signout', 'author'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export function clientEmail(kind: ClientKind, browser: string): string {
  return kind + '.' + browser + '@example.test';
}

export function clientId(kind: ClientKind, browser: string): string {
  return 'u_e2e_' + kind + '_' + browser;
}

/** Text of a client comment that the admin resolves and deletes in (e). */
export function otherCommentBody(browser: string): string {
  return 'The title should be bigger (client comment, ' + browser + ')';
}

/**
 * Text of a comment, by the admin or by the client, whose only file has no
 * recorded uploader (a row from before the uploader column), for (k).
 */
export function legacyFileBody(who: 'admin' | 'client', browser: string): string {
  return 'Old note with an old file (' + who + ', ' + browser + ')';
}

function q(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** SQL of the sample data; `siteOrigin` = staging_url of the project. */
export function seedSql(siteOrigin: string): string {
  const now = Date.now();
  const rows: string[] = [];
  rows.push(
    `INSERT INTO users (id, email, role, name, created_at) VALUES (${q(ADMIN.id)}, ${q(ADMIN.email)}, 'admin', ${q(ADMIN.name)}, ${now});`,
  );
  rows.push(
    `INSERT INTO projects (id, name, slug, staging_url, created_at) VALUES (${q(PROJECT.id)}, ${q(PROJECT.name)}, ${q(PROJECT.slug)}, ${q(siteOrigin)}, ${now});`,
  );
  BROWSERS.forEach((b, i) => {
    for (const kind of CLIENT_KINDS) {
      rows.push(
        `INSERT INTO users (id, email, role, name, created_at) VALUES (${q(clientId(kind, b))}, ${q(clientEmail(kind, b))}, 'client', ${q('Client ' + kind)}, ${now});`,
      );
      rows.push(
        `INSERT INTO memberships (user_id, project_id, created_at, role) VALUES (${q(clientId(kind, b))}, ${q(PROJECT.id)}, ${now}, 'client');`,
      );
    }
    // Someone else's comment for (e): at a different spot per browser, on the home page, desktop.
    rows.push(
      `INSERT INTO comments (id, project_id, parent_id, page_path, page_x, page_y, viewport_w, viewport, body, author_id, status, created_at)
       VALUES (${q('c_e2e_other_' + b)}, ${q(PROJECT.id)}, NULL, '/', ${300 + i * 300}, 420, 1440, 'desktop', ${q(otherCommentBody(b))}, ${q(clientId('author', b))}, 'open', ${now + i});`,
    );
    // For (k): own comments whose file has no recorded uploader (created_by NULL).
    for (const [who, author, x] of [['admin', ADMIN.id, 200], ['client', clientId('author', b), 520]] as const) {
      const cid = 'c_e2e_legacy_' + who + '_' + b;
      rows.push(
        `INSERT INTO comments (id, project_id, parent_id, page_path, page_x, page_y, viewport_w, viewport, body, author_id, status, created_at)
         VALUES (${q(cid)}, ${q(PROJECT.id)}, NULL, '/', ${x + i * 40}, 760, 1440, 'desktop', ${q(legacyFileBody(who, b))}, ${q(author)}, 'open', ${now + i});`,
      );
      rows.push(
        `INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by)
         VALUES (${q('a_e2e_legacy_' + who + '_' + b)}, ${q(cid)}, ${q(PROJECT.id)}, ${q('att/legacy-' + who + '-' + b)}, 'old-notes.pdf', 'application/pdf', 10, ${now}, NULL);`,
      );
    }
  });
  return rows.join('\n') + '\n';
}
