<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import type { CommentRow } from '../api';
import { ProxyChannel } from '../proxy-channel';

const props = defineProps<{ slug: string }>();
const router = useRouter();

const loading = ref(true);
const error = ref('');
const projectName = ref('');
const iframeSrc = ref('');
const isClient = ref(false);
// Preview size: changes the iframe width to see the
// site as on a desktop, tablet or phone.
const viewport = ref<'desktop' | 'tablet' | 'mobile'>('desktop');

// iframe ref, used to send the widget-token via postMessage after the load
// instead of putting it in the query string (no Referer leak).
const iframeEl = ref<HTMLIFrameElement | null>(null);

// CANONICAL desktop width. With a fluid width:100% desktop frame, every
// reviewer would see the responsive site at a different width (their own
// monitor) and anchored/absolute pins would land in different places for
// different reviewers. So the desktop frame is ALWAYS DESKTOP_W px wide inside
// (window.innerWidth in the iframe = 1440 for everyone) and is shrunk with
// transform:scale to fit a narrower stage. Tablet/mobile already use a fixed
// width (768/390) and do not drift: they stay as they are (the wrapper
// disappears with display:contents).
const DESKTOP_W = 1440;
const stageEl = ref<HTMLElement | null>(null);
const stageW = ref(0);
const stageH = ref(0);
let stageRO: ResizeObserver | null = null;
// Scale factor: 1 if the stage is >= 1440, otherwise it shrinks.
const desktopScale = computed(() =>
  viewport.value === 'desktop' && stageW.value > 0
    ? Math.min(1, stageW.value / DESKTOP_W)
    : 1,
);
// Desktop iframe style: fixed inner width 1440, height compensated for the
// scale (so the content fills the stage), origin at the top left.
const siteStyle = computed(() => {
  if (viewport.value !== 'desktop' || stageH.value === 0) return {};
  const s = desktopScale.value;
  return {
    width: DESKTOP_W + 'px',
    height: stageH.value / s + 'px',
    transform: 'scale(' + s + ')',
    transformOrigin: 'top left',
  };
});
// Desktop wrapper style: VISUAL (post-scale) size, so the stage flexbox
// centers it without a spurious horizontal scrollbar.
const wrapStyle = computed(() => {
  if (viewport.value !== 'desktop' || stageH.value === 0) return {};
  return {
    width: DESKTOP_W * desktopScale.value + 'px',
    height: stageH.value + 'px',
  };
});
const widgetToken = ref('');
const widgetRole = ref<'admin' | 'client'>('client');
const widgetProject = ref('');
// Deep link: when the widget asks to open a comment on another page,
// we navigate the iframe and pass openId in the init of the new load.
const pendingOpenId = ref('');
// Navigation nonce: since the widget can navigate INSIDE the iframe (the
// site's internal links), our iframeSrc no longer reflects the iframe's real
// location. Without a value that always changes, asking to go to a page that
// matches the "old" iframeSrc would leave :src unchanged and the iframe would
// NOT reload (= the cross-page jump does nothing). The nonce makes every
// navigation change the URL, so the reload is guaranteed. The widget
// ignores the pinna_nav parameter.
let navNonce = 0;
// Origin of the client's staging site: used as the postMessage targetOrigin
// (defense in depth: even if the iframe redirects to another origin, the
// message is not delivered).
const stagingOrigin = ref('');
// Proxy: /_proxy authenticates with the proxy-token in the URL (pinna_pt), not
// with the cookie. The proxied page runs in a sandbox with an opaque origin
// ("null"): the app accepts a message only if it comes from its own iframe AND
// carries a proxy-token issued here. The hello is accepted once per document
// and opens a channel with a secret that every other message must carry back
// (see proxy-channel.ts): knowing the pt is not enough.
const proxyToken = ref('');
const channel = new ProxyChannel();
function rememberProxyToken(t: string | null | undefined): void {
  if (!t) return;
  proxyToken.value = t;
  channel.issue(t);
}
/** Changes the proxy frame URL: the new document will be allowed to say hello. */
function setProxySrc(url: string): void {
  channel.expectNewDocument();
  iframeSrc.value = url;
}
/** iframe sandbox in proxy mode: no same origin and no navigation of the
 *  app page; external links open in a new tab. */
const PROXY_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
/** iframe sandbox in direct mode: the staging site keeps its own origin (the
 *  widget needs its storage and the postMessage handshake), but with no
 *  top-navigation token a script on the site cannot navigate this tab away. */
const DIRECT_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
// Non-blocking warning if the widget-token refresh fails (expired session /
// network). The widget's actions would start failing silently: better to
// tell the user, with a "Reload" button.
const sessionWarn = ref(false);

/**
 * Admin actions requested by the widget: the widget-token cannot resolve or
 * delete other people's content, because it lives in the site's document,
 * where third-party scripts also run. The widget sends 'pinna-admin' and the
 * user confirms here, IN THE APP PAGE; then the call goes out with the session
 * (cookie + CSRF). A site script can imitate the message but cannot click this
 * confirmation. The confirmation text comes from the API (not from the
 * message), and only one request at a time: a new one while another is
 * pending is refused, it does not replace the pending one.
 */
type AdminAction = 'status' | 'delete-comment' | 'delete-attachment';
interface AdminRequest {
  reqId: string;
  action: AdminAction;
  id: string;
  status?: 'open' | 'done';
  question: string;
  excerpt: string;
}
const adminReq = ref<AdminRequest | null>(null);
const adminBusy = ref(false);
const adminError = ref('');

function replyToWidget(msg: Record<string, unknown>): void {
  const frame = iframeEl.value;
  if (!frame || !frame.contentWindow) return;
  if (!useProxy.value && !stagingOrigin.value) return;
  frame.contentWindow.postMessage(
    { type: 'pinna-admin-result', ...msg },
    useProxy.value ? '*' : stagingOrigin.value,
  );
}

function excerptOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 89) + '...' : t;
}

// A request is being prepared (its comment list is loading). Set before the
// await, synchronously: two messages posted back to back must not both pass
// the "one at a time" check, or the second would replace the first in the bar
// while the user is about to click it.
let adminPending = false;

async function handleAdminRequest(data: Record<string, unknown>): Promise<void> {
  const reqId = typeof data.reqId === 'string' ? data.reqId.slice(0, 80) : '';
  const action = data.action as AdminAction;
  const id = typeof data.id === 'string' ? data.id.slice(0, 100) : '';
  if (!reqId) return;
  const refuse = (error: string) => replyToWidget({ reqId, ok: false, error });
  if (!['status', 'delete-comment', 'delete-attachment'].includes(action) || !id) return refuse('invalid request');
  if (widgetRole.value !== 'admin') return refuse('not authorized');
  if (adminPending || adminReq.value) return refuse("another confirmation is pending");
  const status = data.status === 'done' || data.status === 'open' ? data.status : undefined;
  if (action === 'status' && !status) return refuse('invalid request');

  adminPending = true;
  try {
    // The text to confirm comes from the API, not from the message.
    let rows: CommentRow[];
    try {
      rows = await api.comments(props.slug);
    } catch {
      return refuse('invalid session, reload the page');
    }
    if (adminReq.value) return refuse("another confirmation is pending");
    let question = '';
    let excerpt = '';
    if (action === 'delete-attachment') {
      const owner = rows.find((r) => r.attachments.some((a) => a.id === id));
      const att = owner?.attachments.find((a) => a.id === id);
      if (!att) return refuse('attachment not found');
      question = "Delete the attachment?";
      excerpt = att.filename;
    } else {
      const row = rows.find((r) => r.id === id);
      if (!row) return refuse('comment not found');
      // Deleting a pin deletes its whole thread: the bar shows only the pin's
      // text, so the question says how many replies go with it.
      const replies = row.parent_id === null ? rows.filter((r) => r.parent_id === id).length : 0;
      question =
        action === 'delete-comment'
          ? replies > 0
            ? 'Delete the comment and its ' + replies + (replies === 1 ? ' reply?' : ' replies?')
            : 'Delete the comment?'
          : status === 'done'
            ? 'Mark the comment as done?'
            : 'Reopen the comment?';
      excerpt = row.body;
    }
    adminError.value = '';
    adminReq.value = { reqId, action, id, status, question, excerpt: excerptOf(excerpt) };
  } finally {
    adminPending = false;
  }
}

async function confirmAdmin(): Promise<void> {
  const r = adminReq.value;
  if (!r || adminBusy.value) return;
  adminBusy.value = true;
  try {
    if (r.action === 'status' && r.status) await api.setCommentStatus(r.id, r.status);
    else if (r.action === 'delete-comment') await api.deleteComment(r.id);
    else if (r.action === 'delete-attachment') await api.deleteAttachment(r.id);
    replyToWidget({ reqId: r.reqId, ok: true });
    adminReq.value = null;
  } catch (e) {
    adminError.value = (e as Error).message || 'Failed, please try again.';
  } finally {
    adminBusy.value = false;
  }
}

function cancelAdmin(): void {
  const r = adminReq.value;
  if (!r) return;
  replyToWidget({ reqId: r.reqId, ok: false, cancelled: true });
  adminReq.value = null;
  adminError.value = '';
}

// Preview mode: direct (snippet in the site, default) or proxy (for
// sites that block the iframe, e.g. Shopify). stagingUrlRaw keeps the raw URL
// to rebuild iframeSrc when the mode changes.
const useProxy = ref(false);
const stagingUrlRaw = ref('');
// Proxy enabled on the server: when it is off, the button does not appear.
const proxyEnabled = ref(false);

// On open: ask for the project's widget-token and build the URL of the
// staging site with the parameters the widget reads inside the frame.
onMounted(async () => {
  try {
    const res = await api.widgetToken(props.slug);
    projectName.value = res.project.name;
    isClient.value = res.role === 'client';
    if (!res.project.staging_url) {
      error.value =
        'This project has no site URL yet. Add one from the dashboard to start reviewing.';
      return;
    }
    // Store the data for the post-load postMessage and to build the URL.
    widgetToken.value = res.token;
    widgetRole.value = res.role;
    widgetProject.value = res.project.slug;
    rememberProxyToken(res.proxy_token);
    proxyEnabled.value = res.proxy_enabled === true;
    stagingUrlRaw.value = res.project.staging_url;
    // Build iframeSrc + stagingOrigin for the current mode (direct/proxy).
    applyMode();
  } catch (e) {
    error.value =
      (e as Error).message || 'Could not open this project. Please try again in a moment.';
  } finally {
    loading.value = false;
  }
});

/**
 * When the iframe finishes loading, send the widget its parameters via
 * postMessage. targetOrigin = origin of the staging site (never '*': if
 * the iframe redirects elsewhere the message is not delivered, so
 * nothing leaks).
 */
function handleIframeLoad(): void {
  // In proxy mode the document origin is opaque: no "blind" send on load,
  // we only reply to the widget's verified 'pinna-hello'.
  if (!useProxy.value) sendInitToWidget();
}

function sendInitToWidget(): void {
  const frame = iframeEl.value;
  if (!frame || !frame.contentWindow) return;
  if (!widgetToken.value) return;
  if (!useProxy.value && !stagingOrigin.value) return;
  const msg: Record<string, unknown> = {
    type: 'pinna-init',
    token: widgetToken.value,
    project: widgetProject.value,
    role: widgetRole.value,
  };
  // Proxy: secret of the channel opened by the hello (no channel, no init).
  if (useProxy.value) {
    if (!channel.current) return;
    msg.ch = channel.current;
  }
  if (pendingOpenId.value) {
    msg.openId = pendingOpenId.value;
    pendingOpenId.value = '';
  }
  // Proxy: a sandboxed document has origin "null" and a specific targetOrigin
  // would not reach it, hence '*'. We only get here in reply to a verified
  // message (source = our iframe + our proxy-token).
  frame.contentWindow.postMessage(msg, useProxy.value ? '*' : stagingOrigin.value);
}

/**
 * True if the message comes from OUR iframe. Direct: origin = staging.
 * Proxy: origin "null" (sandbox) + proxy-token issued by this view. Another
 * frame, another window or an external site loaded in the iframe do not pass.
 */
function fromOwnFrame(event: MessageEvent): boolean {
  const frame = iframeEl.value;
  if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return false;
  if (useProxy.value) {
    const d = event.data as { pt?: unknown } | null;
    return event.origin === 'null' && !!d && channel.knows(d.pt);
  }
  return !!stagingOrigin.value && event.origin === stagingOrigin.value;
}

/** Proxy frame URL for a staging address (with the proxy-token). */
function proxySrc(url: string, nav?: number): string {
  const self = window.location.origin;
  const params = new URLSearchParams({
    url,
    pinna_pt: proxyToken.value,
    pinna_pm: '1',
    pinna_project: widgetProject.value,
    pinna_api: self,
    pinna_role: widgetRole.value,
  });
  if (nav != null) params.set('pinna_nav', String(nav));
  return self + '/_proxy?' + params.toString();
}

/**
 * Builds iframeSrc + stagingOrigin for the current mode.
 * - direct (default): the iframe loads the staging_url; the widget (snippet in
 *   the site) reads the pinna_* params from the query and does the handshake.
 *   postMessage origin = staging origin.
 * - proxy: for sites that block the iframe (Shopify etc.) the iframe loads
 *   /_proxy?url=<staging>&pinna_pt=<proxy-token>&... The pinna_* params travel
 *   on the proxy URL (the widget reads them from location.search the same way).
 *   The proxied page is sandboxed (origin "null"): see fromOwnFrame and 'pinna-hello'.
 */
function applyMode(): void {
  const raw = stagingUrlRaw.value;
  if (!raw) return;
  const self = window.location.origin;
  if (useProxy.value) {
    if (!proxyToken.value) {
      error.value = 'Invalid site URL for the proxy.';
      return;
    }
    setProxySrc(proxySrc(raw));
    stagingOrigin.value = '';
  } else {
    try {
      const url = new URL(raw);
      url.searchParams.set('pinna_pm', '1');
      url.searchParams.set('pinna_project', widgetProject.value);
      url.searchParams.set('pinna_api', self);
      url.searchParams.set('pinna_role', widgetRole.value);
      iframeSrc.value = url.toString();
      stagingOrigin.value = url.origin;
    } catch {
      error.value = 'Invalid site URL.';
    }
  }
}

/** Toggles direct <-> proxy preview (for sites that block the iframe). */
function toggleProxy(): void {
  useProxy.value = !useProxy.value;
  pendingOpenId.value = '';
  applyMode(); // changes iframeSrc -> the iframe reloads -> handleIframeLoad resends init
}

/**
 * Silent refresh: the widget (inside the staging iframe) asks for a new
 * widget-token when its API calls return 401 (1h TTL expired). The parent
 * repeats the request to /api/projects/:slug/widget-token (authenticated with
 * the user's session cookie) and sends it back to the widget via postMessage.
 * It checks event.origin so external sites cannot send fake refresh
 * requests.
 */
async function handleWidgetMessage(event: MessageEvent): Promise<void> {
  if (!fromOwnFrame(event)) return;
  const data = event.data as { type?: string; path?: string; openId?: string; url?: string; pt?: unknown; ch?: unknown } | null;
  if (!data) return;

  // Proxy: apart from the hello (and the expired proxy-token page, which has no
  // widget), every message must carry the channel secret.
  if (useProxy.value && data.type !== 'pinna-hello' && data.type !== 'pinna-proxy-expired') {
    if (!channel.check(data.ch)) return;
  }

  // Admin action requested by the widget: confirmed in the app page.
  if (data.type === 'pinna-admin') {
    await handleAdminRequest(data as Record<string, unknown>);
    return;
  }

  // Proxy: the widget introduces itself (opaque origin). One hello per document:
  // it opens the channel and only then is the init sent (with the secret).
  if (data.type === 'pinna-hello') {
    if (useProxy.value && channel.hello(data.pt)) sendInitToWidget();
    return;
  }

  // The widget is leaving the page (navigation inside the frame): the incoming
  // document will be allowed to say hello.
  if (data.type === 'pinna-bye') {
    if (useProxy.value) channel.bye(data.ch);
    return;
  }

  // Proxy-token expired: the proxy page asks for a reload. New token and the
  // same page (only if it stays on the project's staging origin).
  if (data.type === 'pinna-proxy-expired' && useProxy.value) {
    try {
      const res = await api.widgetToken(props.slug);
      widgetToken.value = res.token;
      widgetRole.value = res.role;
      rememberProxyToken(res.proxy_token);
      const want = typeof data.url === 'string' ? data.url : '';
      const base = new URL(stagingUrlRaw.value);
      let next = base.toString();
      try {
        const u = new URL(want);
        if (u.origin === base.origin) next = u.toString();
      } catch { /* url missing or malformed: start again from the staging url */ }
      setProxySrc(proxySrc(next, ++navNonce));
    } catch (e) {
      sessionWarn.value = true;
      console.warn('[pinna] proxy-token refresh failed:', (e as Error).message);
    }
    return;
  }

  // The widget asks to open a comment on another page of the site.
  if (data.type === 'pinna-navigate' && typeof data.path === 'string') {
    navigateIframe(data.path, typeof data.openId === 'string' ? data.openId : '');
    return;
  }

  if (data.type !== 'pinna-refresh-token') return;
  try {
    const res = await api.widgetToken(props.slug);
    widgetToken.value = res.token;
    widgetRole.value = res.role;
    widgetProject.value = res.project.slug;
    rememberProxyToken(res.proxy_token);
    sendInitToWidget();
  } catch (e) {
    // Refresh failed (expired session / network): do not interrupt the review,
    // but show a non-blocking warning with "Reload" (no auto-logout: the
    // 401 may be transient).
    sessionWarn.value = true;
    console.warn('[pinna] widget-token refresh failed:', (e as Error).message);
  }
}

/**
 * Rebuilds the iframe URL on a new pathname of the staging site (keeping the
 * pinna_* params) to reach a comment on another page. Only absolute internal
 * paths on the same origin: no '//', no backslash, no external redirects.
 * After the load, sendInitToWidget carries openId.
 */
function navigateIframe(path: string, openId: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return;
  const self = window.location.origin;
  try {
    if (useProxy.value) {
      // Proxy: change only the target site's path inside the url= param,
      // rebuilding /_proxy. It stays on the same target origin (no redirect).
      const targetOrigin = new URL(stagingUrlRaw.value).origin;
      pendingOpenId.value = openId;
      setProxySrc(proxySrc(targetOrigin + path, ++navNonce));
      return;
    }
    const base = new URL(iframeSrc.value);
    const next = new URL(path, base.origin);
    if (next.origin !== base.origin) return; // defense: stay on the staging origin
    next.searchParams.set('pinna_pm', '1');
    next.searchParams.set('pinna_project', widgetProject.value);
    next.searchParams.set('pinna_api', self);
    next.searchParams.set('pinna_role', widgetRole.value);
    next.searchParams.set('pinna_nav', String(++navNonce));
    pendingOpenId.value = openId;
    iframeSrc.value = next.toString();
  } catch {
    /* malformed path: ignore */
  }
}

onMounted(() => {
  window.addEventListener('message', handleWidgetMessage);
});
// The stage lives in the v-else branch (rendered only after the load): attach
// the ResizeObserver when the element appears, detach it if it goes away.
watch(stageEl, (el) => {
  if (stageRO) {
    stageRO.disconnect();
    stageRO = null;
  }
  if (el && 'ResizeObserver' in window) {
    stageRO = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        stageW.value = r.width;
        stageH.value = r.height;
      }
    });
    stageRO.observe(el);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('message', handleWidgetMessage);
  if (stageRO) {
    stageRO.disconnect();
    stageRO = null;
  }
});

function reloadPage(): void {
  window.location.reload();
}

async function logout() {
  // Server-side logout clears the cookies. If the call fails (network down)
  // the cookie stays alive: the ?logout=1 flag tells LoginView NOT to sign back in
  // automatically, so "Sign out" always leaves the user on the sign-in screen.
  await api.logout().catch(() => {});
  router.replace({ name: 'login', query: { logout: '1' } });
}

// Email notifications: each user can mute their own.
const muted = ref(false);
api.notificationPrefs().then((p) => { muted.value = p.muted; }).catch(() => {});
async function toggleMute() {
  try {
    const r = await api.setMute(!muted.value);
    muted.value = r.muted;
  } catch { /* leave the state as it is */ }
}
</script>

<template>
  <div class="frame">
    <header class="topbar">
      <div class="lead">
        <button v-if="!isClient" class="back" type="button" @click="router.push({ name: 'dashboard' })">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 6 9 12l6 6" />
          </svg>
          All sites
        </button>
        <span v-else class="brand" role="img" aria-label="Pinna" />
        <span class="sep" aria-hidden="true" />
        <span class="name">{{ projectName || 'Project' }}</span>
      </div>

      <div v-if="iframeSrc" class="vp" role="group" aria-label="Preview size">
        <button
          type="button" title="Desktop" aria-label="Desktop"
          :class="{ on: viewport === 'desktop' }" :aria-pressed="viewport === 'desktop'"
          @click="viewport = 'desktop'"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="3.5" width="20" height="13.5" rx="2" />
            <path d="M8.5 21h7M12 17v4" />
          </svg>
        </button>
        <button
          type="button" title="Tablet" aria-label="Tablet"
          :class="{ on: viewport === 'tablet' }" :aria-pressed="viewport === 'tablet'"
          @click="viewport = 'tablet'"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
            <path d="M11.25 18.5h1.5" />
          </svg>
        </button>
        <button
          type="button" title="Phone" aria-label="Phone"
          :class="{ on: viewport === 'mobile' }" :aria-pressed="viewport === 'mobile'"
          @click="viewport = 'mobile'"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="7.5" y="2.5" width="9" height="19" rx="2.2" />
            <path d="M11.25 18.5h1.5" />
          </svg>
        </button>
      </div>
      <span v-else />

      <div class="actions">
        <button
          v-if="stagingUrlRaw && !isClient && proxyEnabled" class="exit" type="button"
          :aria-pressed="useProxy"
          :style="useProxy ? 'background:#16a34a;border-color:#16a34a;color:#fff' : ''"
          title="Does the site block the preview (e.g. Shopify, Wix, WordPress)? Load it through the proxy, which works with any URL"
          @click="toggleProxy"
        >
          Proxy {{ useProxy ? 'ON' : 'OFF' }}
        </button>
        <a v-if="iframeSrc" class="open" :href="iframeSrc" target="_blank" rel="noopener">
          Open full screen
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 5h5v5M19 5l-8 8" />
            <path d="M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" />
          </svg>
        </a>
        <button
          class="icon-btn" type="button" :class="{ 'is-muted': muted }"
          :title="muted ? 'Email notifications muted' : 'Email notifications on'"
          :aria-label="muted ? 'Unmute notifications' : 'Mute notifications'"
          @click="toggleMute"
        >
          <svg v-if="!muted" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
            <path d="m3 3 18 18" />
          </svg>
        </button>
        <button class="exit" type="button" @click="logout">Sign out</button>
      </div>
    </header>

    <div v-if="sessionWarn" class="session-warn" role="alert">
      <span>Your session may have expired: some actions might not be saved.</span>
      <button type="button" @click="reloadPage">Reload</button>
      <button type="button" class="sw-x" aria-label="Dismiss warning" @click="sessionWarn = false">&times;</button>
    </div>

    <div v-if="adminReq" class="admin-confirm" role="alertdialog" aria-labelledby="admin-q">
      <span id="admin-q" class="ac-q">{{ adminReq.question }}</span>
      <span class="ac-x">&laquo;{{ adminReq.excerpt }}&raquo;</span>
      <span v-if="adminError" class="ac-err">{{ adminError }}</span>
      <button type="button" class="ac-go" :disabled="adminBusy" @click="confirmAdmin">
        {{ adminReq.action === 'status' ? 'Confirm' : 'Delete' }}
      </button>
      <button type="button" :disabled="adminBusy" @click="cancelAdmin">Cancel</button>
    </div>

    <p v-if="loading" class="state" role="status">Opening the site...</p>

    <div v-else-if="error" class="state error" role="alert">
      <p class="error-title">Could not open</p>
      <p class="error-text">{{ error }}</p>
      <button class="retry" type="button" @click="reloadPage">
        Try again
      </button>
    </div>

    <div v-else ref="stageEl" class="stage">
      <div :class="['site-wrap', 'site-wrap--' + viewport]" :style="wrapStyle">
        <iframe
          :key="useProxy ? 'proxy' : 'direct'"
          ref="iframeEl"
          :sandbox="useProxy ? PROXY_SANDBOX : DIRECT_SANDBOX"
          :class="['site', 'site--' + viewport]"
          :style="siteStyle"
          :src="iframeSrc"
          :title="'Preview of ' + projectName"
          @load="handleIframeLoad"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.frame {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  flex: none;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

/* --- Left: navigation/brand + project name --- */
.lead {
  justify-self: start;
  display: flex; align-items: center; gap: 12px;
  min-width: 0;
}
.back {
  display: flex; align-items: center; gap: 6px; flex: none;
  height: 34px; padding: 0 12px 0 8px; border-radius: 8px;
  border: 1px solid var(--line-2); background: var(--surface);
  color: var(--text-2); font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.back:hover { background: var(--bg-2); color: var(--text); }
.back svg { width: 17px; height: 17px; }
.brand {
  flex: none;
  width: 66px; height: 19px;
  background: var(--grad);
  -webkit-mask: url(/pinna-wordmark.svg) left center / contain no-repeat;
  mask: url(/pinna-wordmark.svg) left center / contain no-repeat;
}
.sep { flex: none; width: 1px; height: 20px; background: var(--line-2); }
.name {
  font-size: 14px; font-weight: 650; letter-spacing: -0.01em;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* --- Center: preview size selector --- */
.vp {
  justify-self: center;
  display: flex; gap: 2px;
  padding: 3px; border-radius: 9px; background: var(--bg-2);
}
.vp button {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 28px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text-3); cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.vp button:hover { color: var(--text-2); }
.vp button.on {
  background: var(--surface); color: var(--accent);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.13);
}
.vp button:focus-visible {
  outline: none; box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.28);
}
.vp button svg { width: 17px; height: 17px; }

/* --- Right: actions --- */
.actions {
  justify-self: end;
  display: flex; align-items: center; gap: 8px;
}
.open {
  display: flex; align-items: center; gap: 6px; flex: none;
  height: 34px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--line-2); background: var(--surface);
  color: var(--text-2); font-size: 13px; font-weight: 600;
  transition: background .14s ease, color .14s ease;
}
.open:hover { background: var(--bg-2); color: var(--text); }
.open svg { width: 15px; height: 15px; }
.exit {
  flex: none;
  height: 34px; padding: 0 13px; border-radius: 8px;
  border: 1px solid var(--line-2); background: var(--surface);
  color: var(--text-2); font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.exit:hover { background: var(--bg-2); color: var(--text); }
.icon-btn {
  flex: none;
  display: flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 8px;
  border: 1px solid var(--line-2); background: var(--surface);
  color: var(--text-2); cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.icon-btn:hover { background: var(--bg-2); color: var(--text); }
.icon-btn.is-muted { color: var(--text-3); }
.icon-btn svg { width: 17px; height: 17px; }

/* --- Stage: the site being previewed --- */
.stage {
  flex: 1; min-height: 0;
  display: flex; justify-content: center;
  background: var(--bg-2);
  overflow: auto;
}
/* Frame wrapper. On tablet/mobile it disappears (display:contents) and
   the iframe stays a direct child of the stage.
   On desktop it becomes the VISUAL box (post-scale size via inline :style)
   that the stage flexbox centers without a spurious horizontal scroll. */
.site-wrap--tablet, .site-wrap--mobile { display: contents; }
.site-wrap--desktop { flex: none; overflow: hidden; }

.site {
  height: 100%; border: 0; background: #fff;
  transition: width .22s var(--ease);
}
/* Desktop: canonical inner width 1440 + scale via inline :style.
   The real width/height/transform come from siteStyle; this is only the
   fallback while the stage is not measured yet (first frame). */
.site--desktop { width: 1440px; }
.site--tablet {
  width: 768px; flex: none;
  box-shadow: 0 0 0 1px var(--line), 0 22px 55px -30px rgba(15, 23, 42, 0.5);
}
.site--mobile {
  width: 390px; flex: none;
  box-shadow: 0 0 0 1px var(--line), 0 22px 55px -30px rgba(15, 23, 42, 0.5);
}

.state {
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 4px; padding: 40px 26px; text-align: center;
  color: var(--text-3); font-size: 14.5px;
}
.error-title { font-size: 17px; font-weight: 650; color: var(--text); }
.error-text {
  margin-top: 4px; max-width: 46ch; line-height: 1.55;
  color: var(--text-3); font-size: 14px;
}
.retry {
  margin-top: 16px; height: 40px; padding: 0 18px;
  border: 0; border-radius: 10px;
  background: var(--grad); color: #fff; font-size: 14px; font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px -3px rgba(0, 102, 204, 0.45);
  transition: box-shadow .14s ease;
}
.retry:hover { box-shadow: 0 6px 18px -3px rgba(0, 102, 204, 0.55); }

.session-warn {
  flex: none;
  display: flex; align-items: center; gap: 12px;
  padding: 9px 16px;
  background: #fef3c7; color: #92400e;
  font-size: 13px; line-height: 1.4;
  border-bottom: 1px solid #fde68a;
}
.session-warn button {
  flex: none;
  height: 28px; padding: 0 12px; border-radius: 7px;
  border: 1px solid #d97706; background: #fff; color: #92400e;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.session-warn button:hover { background: #fffbeb; }
.session-warn .sw-x {
  margin-left: auto; border: 0; background: transparent;
  padding: 0 6px; font-size: 18px;
}

.admin-confirm {
  flex: none;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 9px 16px;
  background: #eff6ff; color: #1e3a8a;
  font-size: 13px; line-height: 1.4;
  border-bottom: 1px solid #bfdbfe;
}
.admin-confirm .ac-q { font-weight: 600; }
.admin-confirm .ac-x {
  min-width: 0; flex: 1 1 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #334155;
}
.admin-confirm .ac-err { color: #b91c1c; }
.admin-confirm button {
  flex: none;
  min-height: 32px; padding: 0 14px; border-radius: 7px;
  border: 1px solid #93c5fd; background: #fff; color: #1e3a8a;
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.admin-confirm button.ac-go { background: #0066cc; border-color: #0066cc; color: #fff; }
.admin-confirm button:disabled { opacity: 0.6; cursor: default; }

@media (max-width: 640px) {
  .open { display: none; }
}
</style>
