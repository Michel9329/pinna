/** Pinna app - API client. Same origin as the Worker: the session cookie is sent automatically. */

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'collab' | 'client';
  name: string | null;
}

export interface ProjectCard {
  id: string;
  name: string;
  slug: string;
  staging_url: string;
  created_at: number;
  /** The user's role on THIS project (collab = site admin). */
  my_role?: 'admin' | 'collab' | 'client';
  can_admin?: boolean;
  counts: { open: number; done: number };
}

/** A comment as returned by the API (only the fields the app needs). */
export interface CommentRow {
  id: string;
  parent_id: string | null;
  body: string;
  author_role: string;
  status: 'open' | 'done';
  attachments: { id: string; filename: string }[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Reads a cookie via document.cookie (CSRF double-submit). */
function readCookie(name: string): string {
  const re = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)');
  const m = document.cookie.match(re);
  return m && m[1] ? m[1] : '';
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // On mutating methods, send the CSRF token read from the __Host-pinna_csrf
  // cookie. The server compares it with the cookie via safeEqual.
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT') {
    const csrf = readCookie('__Host-pinna_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error || 'HTTP ' + res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => req<User>('/auth/me'),
  requestLogin: (email: string) =>
    req<{ ok: boolean; devLink?: string; devCode?: string }>('/auth/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  // Sign in with the 6-digit code. The server sets the session cookies via
  // Set-Cookie on the response (a same-origin fetch stores them).
  verifyCode: (email: string, code: string) =>
    req<{ ok: boolean }>('/auth/verify-code', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  projects: () => req<ProjectCard[]>('/projects'),
  createProject: (name: string, staging_url: string) =>
    req<ProjectCard>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, staging_url }),
    }),
  widgetToken: (slug: string) =>
    req<{
      token: string;
      /** Proxy enabled on the server (PINNA_PROXY_ENABLED): without it, no Proxy button. */
      proxy_enabled?: boolean;
      /** Proxy-token for /_proxy (only the project's staging origin, 1 hour). */
      proxy_token: string | null;
      role: 'admin' | 'client';
      project: { id: string; slug: string; name: string; staging_url: string };
    }>('/projects/' + encodeURIComponent(slug) + '/widget-token'),
  notificationPrefs: () => req<{ muted: boolean }>('/notifications/me'),
  setMute: (muted: boolean) =>
    req<{ muted: boolean }>('/notifications/mute', {
      method: 'POST',
      body: JSON.stringify({ muted }),
    }),
  // Admin actions on comments: only from the app session, with CSRF. The
  // widget requests them via postMessage and the user confirms them here.
  comments: (slug: string) =>
    req<CommentRow[]>('/projects/' + encodeURIComponent(slug) + '/comments'),
  setCommentStatus: (id: string, status: 'open' | 'done') =>
    req<unknown>('/comments/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  deleteComment: (id: string) =>
    req<{ ok: boolean }>('/comments/' + encodeURIComponent(id), { method: 'DELETE' }),
  deleteAttachment: (id: string) =>
    req<{ ok: boolean }>('/attachments/' + encodeURIComponent(id), { method: 'DELETE' }),
  invite: (projectId: string, email: string, role?: 'client' | 'collab') =>
    req<{ ok: boolean }>('/projects/' + encodeURIComponent(projectId) + '/invite', {
      method: 'POST',
      body: JSON.stringify(role ? { email, role } : { email }),
    }),
};
