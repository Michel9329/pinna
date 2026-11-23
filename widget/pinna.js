/**
 * Pinna - visual review widget for client sites in staging.
 *
 * It is injected into the staging build (*.pages.dev) and shows a comment overlay:
 * the client clicks a spot and leaves a comment; an admin replies or marks it "Done".
 * A sidebar on the left summarizes the comments, with Open / Done tabs.
 *
 * Light look: white surfaces, dark text, blue accent.
 *
 * Two modes: demo (in-memory store, only when the <script> tag carries
 * data-pinna-project, as on the demo page) and live (Worker API, when the
 * site runs inside the Pinna frame). On a real client site embed the bare
 * <script> tag: outside the Pinna frame the widget then stays dormant.
 * Anchoring uses a CSS selector of the clicked element when possible, with
 * absolute page coordinates as the fallback (see "Robust anchoring").
 *
 * Config: data-* attributes on the <script> tag or the URL query (the query
 * takes priority; this is how the Pinna frame passes parameters to the widget).
 *   project   data-pinna-project  /  ?pinna_project=
 *   api       data-pinna-api                         API base URL (in postMessage
 *             mode: ALWAYS the origin pinna.js is loaded from)
 *   token     data-pinna-token                       project widget token
 *   role      data-pinna-role     /  ?pinna_role=    'client' | 'admin'
 *
 * postMessage mode: with ?pinna_pm=1 the widget waits for the parent Pinna
 *   app to pass it the token via postMessage. The token never appears in a
 *   URL (neither ?pinna_wt= nor ?wt= is read): it travels only in the
 *   Authorization header of the API calls.
 *
 * Widget token powers: third-party scripts also run in the site's document
 * and can read the token. For this reason the token can only read comments,
 * create them, edit and delete its own, and attach files. Resolving/reopening
 * and deleting other people's content is done by the Pinna app (session + CSRF)
 * after a confirmation in ITS own page: see adminViaApp.
 */
(async function () {
  'use strict';
  if (window.__pinnaLoaded) return;
  window.__pinnaLoaded = true;

  // --- Config -------------------------------------------------------------
  // The URL query beats the data-* attributes: this is how the Pinna frame
  // passes the widget its token and the API address at runtime.
  var thisScript = document.currentScript;
  var ds = (thisScript && thisScript.dataset) || {};
  var qs = new URLSearchParams(window.location.search);
  var CFG = {
    project: qs.get('pinna_project') || ds.pinnaProject || 'demo',
    // ?pinna_api= is not read: otherwise anyone could frame the staging site
    // with ?pinna_pm=1&pinna_api=<their site>, complete the handshake and
    // receive comments and DOM snapshots. The API is chosen by the site (attribute)
    // or, in postMessage mode, by the origin of pinna.js (see below).
    api: (ds.pinnaApi || '').replace(/\/+$/, ''),
    token: ds.pinnaToken || '',
    role: (qs.get('pinna_role') || ds.pinnaRole) === 'admin' ? 'admin' : 'client',
  };
  // Proxy mode: the proxied page runs in a sandbox with an opaque origin
  // ("null"), so the parent app cannot send us the init to a specific origin.
  // The widget introduces itself first with 'pinna-hello' and the proxy token
  // from its URL (pinna_pt): the app answers only if the message comes from
  // ITS iframe and the token is one it issued.
  // The same pt goes along with token refreshes and cross-page navigation.
  var PROXY_PT = ds.pinnaProxy === '1' ? (qs.get('pinna_pt') || '') : '';
  // Secret of the channel with the parent in proxy mode: it arrives in the init
  // and must be sent back in every later message; the pt alone is not enough.
  var CHANNEL = '';
  // Deep link to a specific comment (cross-page): the parent Pinna app can
  // send openId in the init; after load the widget opens that thread.
  var pendingOpenId = null;
  // --- Persistent cross-page activation (internal navigation) -------------
  // In direct mode (snippet in the site) the pinna_* parameters live ONLY in the
  // URL of the iframe's first load (the home page). Clicking an internal site
  // link loads the new page WITHOUT those parameters: without recovery the
  // widget would not know it is inside the Pinna frame and would stay
  // dormant (= you could only comment on the home page).
  // Recovery: (1) on first activation we save {project, api, role} in
  // sessionStorage (same origin as the site = survives internal
  // navigation); (2) on later pages, if we are STILL inside Pinna,
  // we restore the context and redo the handshake (the parent resends
  // 'pinna-init' on every iframe load). See loadCtx/saveCtx/framedByPinna.
  // Security: a real visitor is never inside a Pinna iframe and never has
  // a saved context, so for them the widget stays invisible.
  var CTX_KEY = '__pinna_ctx';
  var pinnaOrigin = (function () {
    try { return new URL(thisScript.src).origin; } catch (_) { return ''; }
  })();
  function framedByPinna() {
    if (window.parent === window) return false; // outside an iframe: never
    try {
      var ao = window.location.ancestorOrigins;
      if (ao && ao.length) {
        for (var i = 0; i < ao.length; i++) {
          // EXACT comparison with the origin pinna.js is loaded from (no
          // substrings: a look-alike such as pinna.example.com.evil.com must NOT
          // pass; no hardcoded host either).
          // Defense in depth: the site's frame-ancestors CSP already prevents
          // hostile embedding and waitForToken accepts the token only
          // from the real Pinna origin.
          if (ao[i] === pinnaOrigin) return true;
        }
      }
    } catch (_) {}
    return false;
  }
  function loadCtx() {
    try {
      var raw = sessionStorage.getItem(CTX_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (c && typeof c.api === 'string' && c.api
          && typeof c.project === 'string' && c.project) return c;
    } catch (_) {}
    return null;
  }
  function saveCtx() {
    try {
      sessionStorage.setItem(CTX_KEY, JSON.stringify({
        project: CFG.project, api: CFG.api, role: CFG.role,
      }));
    } catch (_) {}
  }

  // In postMessage mode the token does NOT travel in the querystring.
  var pmMode = qs.get('pinna_pm') === '1';
  // Internal navigation: no pinna_* in the URL but we may still be
  // inside the Pinna frame. We recover the context and switch to
  // postMessage mode so the parent resends the token via 'pinna-init'.
  if (!pmMode && !CFG.token && window.parent !== window) {
    var savedCtx = loadCtx();
    if (savedCtx) {
      // Cross-browser: the context is saved only after a real activation
      // inside Pinna in this session/origin (a visitor never has it).
      CFG.project = savedCtx.project;
      CFG.api = (savedCtx.api || '').replace(/\/+$/, '');
      CFG.role = savedCtx.role === 'admin' ? 'admin' : 'client';
      pmMode = true;
    } else if (framedByPinna() && pinnaOrigin) {
      // No saved context but the iframe belongs to Pinna (ancestorOrigins):
      // the API is the same origin as the widget; project/role arrive in the init.
      CFG.api = pinnaOrigin;
      pmMode = true;
    }
  }
  // postMessage mode: the only origin to trust for the init (and therefore the
  // API base) is the one this pinna.js was loaded from, i.e. Pinna.
  // Neither the query nor a saved context can move it elsewhere.
  if (pmMode) {
    if (!pinnaOrigin) return;
    CFG.api = pinnaOrigin;
  }
  if (pmMode && !CFG.token && CFG.api) {
    try {
      CFG.token = await waitForToken(CFG.api);
    } catch (_) {
      // if the parent does not answer within the timeout, we stay dormant.
      return;
    }
  }
  var ME = CFG.role;
  // Only admins (developers) can mark comments as done.
  var IS_ADMIN = (ME === 'admin');
  // In proxy mode location.pathname is always '/_proxy' (the frame's path):
  // the reverse proxy injects data-pinna-path with the target's REAL path, so
  // comments anchor to the right page. Outside the proxy (direct snippet)
  // the attribute is absent and location.pathname is used as usual.
  var PATH = ds.pinnaPath || window.location.pathname;
  // LIVE = connected to the real API (the site runs inside the Pinna frame).
  var LIVE = !!(CFG.api && CFG.token && CFG.project);
  if (LIVE) {
    // (1) Persist the context for internal navigation (cross-page).
    saveCtx();
    // (2) Reinforce the site's Sanity Visual Editing gate: the widget KNOWS for
    // certain that it is inside Pinna (token received from the Pinna origin via
    // postMessage handshake), so it sets __pinna_frame so that the
    // "Open in Studio" overlay stays suppressed on ALL pages reached in the
    // frame (the client should only comment, never open the Studio).
    // Key shared with the Sanity-gate snippet in the client site's base
    // layout (framedByPinna). The flag can only DISABLE overlays, so there is
    // no leak risk; outside an iframe the Sanity gate does not enable them
    // anyway (window.parent === window).
    try { sessionStorage.setItem('__pinna_frame', '1'); } catch (_) {}
    // (3) Proxy mode: when leaving the page (internal link) notify the app with
    // the channel secret, so the next document can say hello.
    if (PROXY_PT) {
      window.addEventListener('pagehide', function () {
        if (!CHANNEL) return;
        try {
          window.parent.postMessage({ type: 'pinna-bye', pt: PROXY_PT, ch: CHANNEL }, CFG.api);
        } catch (_) {}
      });
    }
  }
  // DEMO = explicit call with data-pinna-project (the demo page).
  // The snippet on a real client site has no attributes: outside the
  // Pinna frame the widget stays completely invisible (dormant).
  var DEMO = !LIVE && !!ds.pinnaProject;
  if (!LIVE && !DEMO) return;

  // --- i18n (IT/EN/ES) -----------------------------------------------------
  // Language: ?pinna_lang= in the page URL > data-pinna-lang >
  // navigator.language > 'en'.
  // NB ES: first pass, should be reviewed by a native speaker.
  var LANG = (function () {
    var q = (qs.get('pinna_lang') || ds.pinnaLang || '').toLowerCase().slice(0, 2);
    if (q === 'it' || q === 'en' || q === 'es') return q;
    var n = (navigator.language || 'en').toLowerCase().slice(0, 2);
    return n === 'it' || n === 'es' ? n : 'en';
  })();
  var STR = {
    it: {
      fab_comment: 'Commenta', fab_cancel: 'Annulla',
      fab_aria_open: 'Apri modalità commento', fab_aria_close: 'Esci dalla modalità commento',
      hint_html: '<b>Clicca un punto</b> della pagina per lasciare un commento.',
      handle_comments: 'Commenti', handle_aria: 'Apri elenco commenti',
      sidebar_aria: 'Elenco commenti Pinna', sb_subtitle: 'Revisione del sito',
      tab_open: 'Aperti', tab_done: 'Completati',
      search_ph: 'Cerca nei commenti...', search_aria: 'Cerca nei commenti',
      filter_all: 'Tutti', filter_admin: 'Admin', filter_client: 'Cliente', filter_collab: 'Collab',
      author_admin: 'Admin', author_client: 'Cliente', author_collab: 'Collaboratore',
      page_open: 'apri pagina',
      empty_no_results: 'Nessun risultato',
      empty_no_results_sub: 'Nessun commento corrisponde ai filtri attivi.',
      empty_done: 'Niente di completato', empty_open: 'Nessun commento aperto',
      empty_done_sub: 'I commenti che segni come completati finiscono qui.',
      empty_open_sub: 'Usa Commenta in basso a destra per lasciarne uno.',
      attach_aria: 'Allega un file', attach_remove: 'Rimuovi allegato',
      att_del_confirm: 'Rimuovere?', att_del_yes: 'Rimuovi', att_del_no: 'Annulla',
      err_att_del: 'Non sono riuscito a rimuovere il file, riprova.',
      err_att_admin_only: "Questo file l'ha aggiunto qualcun altro: può rimuoverlo solo un amministratore del progetto.",
      emoji_insert: 'Inserisci emoji', sb_close: 'Chiudi elenco', msg_edit: 'modifica',
      emoji_aria: function (e) { return 'Emoji ' + e; },
      composer_ph: 'Cosa va cambiato qui? Testo, immagine, spaziatura...',
      composer_title: 'Nuovo commento', label_your_comment: 'Il tuo commento',
      btn_send: 'Invia', err_send: 'Invio non riuscito, riprova.',
      badge_done: 'Completato', badge_open: 'Aperto', close_aria: 'Chiudi',
      label_reply: 'Rispondi', btn_reply: 'Rispondi', reply_ph: 'Scrivi una risposta...',
      err_reply: 'Risposta non inviata, riprova.',
      btn_reopen: 'Riapri il commento', btn_mark_done: 'Segna come completato',
      err_status: 'Operazione non riuscita, riprova.',
      btn_delete: 'Elimina commento', err_delete: 'Eliminazione non riuscita, riprova.',
      err_delete_admin_only: 'Qui ha risposto o allegato un file qualcun altro: questa conversazione può eliminarla solo un amministratore del progetto.',
      btn_save: 'Salva', err_save: 'Salvataggio non riuscito, riprova.',
      rel_now: 'adesso',
      rel_min: function (n) { return n + ' min fa'; },
      rel_hour: function (n) { return n + (n === 1 ? ' ora fa' : ' ore fa'); },
      rel_day: function (n) { return n + (n === 1 ? ' giorno fa' : ' giorni fa'); },
      replies: function (n) { return n + (n === 1 ? ' risposta' : ' risposte'); },
      aria_comment: function (n) { return 'Commento ' + n; },
      pos_approx: 'posizione approssimativa, vedi lo screenshot',
      aria_goto_page: function (p) { return 'Vai alla pagina ' + p; },
      aria_goto_comment: function (n) { return 'Vai al commento ' + n; },
      aria_goto_comment_page: function (p, n) { return 'Vai al commento su ' + p + ', numero ' + n; },
    },
    en: {
      fab_comment: 'Comment', fab_cancel: 'Cancel',
      fab_aria_open: 'Open comment mode', fab_aria_close: 'Exit comment mode',
      hint_html: '<b>Click a spot</b> on the page to leave a comment.',
      handle_comments: 'Comments', handle_aria: 'Open comments list',
      sidebar_aria: 'Pinna comments list', sb_subtitle: 'Site review',
      tab_open: 'Open', tab_done: 'Done',
      search_ph: 'Search comments...', search_aria: 'Search comments',
      filter_all: 'All', filter_admin: 'Admin', filter_client: 'Client', filter_collab: 'Collab',
      author_admin: 'Admin', author_client: 'Client', author_collab: 'Collaborator',
      page_open: 'open page',
      empty_no_results: 'No results',
      empty_no_results_sub: 'No comments match the active filters.',
      empty_done: 'Nothing completed', empty_open: 'No open comments',
      empty_done_sub: 'Comments you mark as done show up here.',
      empty_open_sub: 'Use Comment at the bottom right to leave one.',
      attach_aria: 'Attach a file', attach_remove: 'Remove attachment',
      att_del_confirm: 'Remove?', att_del_yes: 'Remove', att_del_no: 'Cancel',
      err_att_del: "Couldn't remove the file, try again.",
      err_att_admin_only: 'Someone else added this file: only a project admin can remove it.',
      emoji_insert: 'Insert emoji', sb_close: 'Close list', msg_edit: 'edit',
      emoji_aria: function (e) { return 'Emoji ' + e; },
      composer_ph: 'What should change here? Text, image, spacing...',
      composer_title: 'New comment', label_your_comment: 'Your comment',
      btn_send: 'Send', err_send: 'Send failed, please try again.',
      badge_done: 'Done', badge_open: 'Open', close_aria: 'Close',
      label_reply: 'Reply', btn_reply: 'Reply', reply_ph: 'Write a reply...',
      err_reply: 'Reply not sent, please try again.',
      btn_reopen: 'Reopen comment', btn_mark_done: 'Mark as done',
      err_status: 'Action failed, please try again.',
      btn_delete: 'Delete comment', err_delete: 'Delete failed, please try again.',
      err_delete_admin_only: 'Someone else has replied or added a file here: only a project admin can delete this thread.',
      btn_save: 'Save', err_save: 'Save failed, please try again.',
      rel_now: 'just now',
      rel_min: function (n) { return n + ' min ago'; },
      rel_hour: function (n) { return n + (n === 1 ? ' hr ago' : ' hrs ago'); },
      rel_day: function (n) { return n + (n === 1 ? ' day ago' : ' days ago'); },
      replies: function (n) { return n + (n === 1 ? ' reply' : ' replies'); },
      aria_comment: function (n) { return 'Comment ' + n; },
      pos_approx: 'approximate position, see the screenshot',
      aria_goto_page: function (p) { return 'Go to page ' + p; },
      aria_goto_comment: function (n) { return 'Go to comment ' + n; },
      aria_goto_comment_page: function (p, n) { return 'Go to comment on ' + p + ', number ' + n; },
    },
    es: {
      fab_comment: 'Comentar', fab_cancel: 'Cancelar',
      fab_aria_open: 'Abrir modo comentario', fab_aria_close: 'Salir del modo comentario',
      hint_html: '<b>Haz clic en un punto</b> de la página para dejar un comentario.',
      handle_comments: 'Comentarios', handle_aria: 'Abrir lista de comentarios',
      sidebar_aria: 'Lista de comentarios Pinna', sb_subtitle: 'Revisión del sitio',
      tab_open: 'Abiertos', tab_done: 'Completados',
      search_ph: 'Buscar comentarios...', search_aria: 'Buscar comentarios',
      filter_all: 'Todos', filter_admin: 'Admin', filter_client: 'Cliente', filter_collab: 'Colab',
      author_admin: 'Admin', author_client: 'Cliente', author_collab: 'Colaboradora',
      page_open: 'abrir página',
      empty_no_results: 'Sin resultados',
      empty_no_results_sub: 'Ningún comentario coincide con los filtros activos.',
      empty_done: 'Nada completado', empty_open: 'Sin comentarios abiertos',
      empty_done_sub: 'Los comentarios que marcas como completados aparecen aquí.',
      empty_open_sub: 'Usa Comentar abajo a la derecha para dejar uno.',
      attach_aria: 'Adjuntar un archivo', attach_remove: 'Quitar adjunto',
      att_del_confirm: '¿Quitar?', att_del_yes: 'Quitar', att_del_no: 'Cancelar',
      err_att_del: 'No se pudo quitar el archivo, inténtalo de nuevo.',
      err_att_admin_only: 'Otra persona agregó este archivo: solo un administrador del proyecto puede quitarlo.',
      emoji_insert: 'Insertar emoji', sb_close: 'Cerrar lista', msg_edit: 'editar',
      composer_ph: '¿Qué hay que cambiar aquí? Texto, imagen, espaciado...',
      composer_title: 'Nuevo comentario', label_your_comment: 'Tu comentario',
      btn_send: 'Enviar', err_send: 'No se pudo enviar, inténtalo de nuevo.',
      badge_done: 'Completado', badge_open: 'Abierto', close_aria: 'Cerrar',
      label_reply: 'Responder', btn_reply: 'Responder', reply_ph: 'Escribe una respuesta...',
      err_reply: 'No se envió la respuesta, inténtalo de nuevo.',
      btn_reopen: 'Reabrir comentario', btn_mark_done: 'Marcar como completado',
      err_status: 'No se pudo completar la acción, inténtalo de nuevo.',
      btn_delete: 'Eliminar comentario', err_delete: 'No se pudo eliminar, inténtalo de nuevo.',
      err_delete_admin_only: 'Otra persona respondió o adjuntó un archivo aquí: solo un administrador del proyecto puede eliminar esta conversación.',
      btn_save: 'Guardar', err_save: 'No se pudo guardar, inténtalo de nuevo.',
      rel_now: 'ahora',
      rel_min: function (n) { return 'hace ' + n + ' min'; },
      rel_hour: function (n) { return 'hace ' + n + (n === 1 ? ' hora' : ' horas'); },
      rel_day: function (n) { return 'hace ' + n + (n === 1 ? ' día' : ' días'); },
      replies: function (n) { return n + (n === 1 ? ' respuesta' : ' respuestas'); },
      aria_comment: function (n) { return 'Comentario ' + n; },
      pos_approx: 'posición aproximada, mira la captura',
      aria_goto_page: function (p) { return 'Ir a la página ' + p; },
      aria_goto_comment: function (n) { return 'Ir al comentario ' + n; },
      aria_goto_comment_page: function (p, n) { return 'Ir al comentario en ' + p + ', número ' + n; },
    },
  };
  function t(key) {
    var d = STR[LANG] || STR.en;
    var v = d[key] != null ? d[key] : STR.en[key];
    if (v == null) return key;
    if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1));
    return v;
  }

  // --- postMessage handshake ------------------------------------------------
  // The parent Pinna app sends {type:'pinna-init', token, ...} as soon as
  // the iframe has loaded. We check event.origin against CFG.api
  // (the Worker origin = same origin as the Pinna SPA app).
  function waitForToken(trustedOrigin) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        window.removeEventListener('message', handler);
        reject(new Error('pinna-init timeout'));
      }, 10000);
      function handler(event) {
        if (event.origin !== trustedOrigin) return;
        var d = event.data;
        if (!d || d.type !== 'pinna-init') return;
        if (typeof d.token !== 'string' || !d.token) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        // Also align role if the parent sends it (overrides the default).
        if (typeof d.role === 'string') {
          CFG.role = d.role === 'admin' ? 'admin' : 'client';
        }
        if (typeof d.project === 'string' && d.project) {
          CFG.project = d.project;
        }
        if (typeof d.openId === 'string' && d.openId) pendingOpenId = d.openId;
        if (PROXY_PT && typeof d.ch === 'string') CHANNEL = d.ch;
        resolve(d.token);
      }
      window.addEventListener('message', handler);
      // Proxy mode: the app waits for our hello before sending the init.
      if (PROXY_PT) {
        try {
          window.parent.postMessage({ type: 'pinna-hello', pt: PROXY_PT }, trustedOrigin);
        } catch (_) {}
      }
    });
  }
  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // In LIVE mode (we are inside the Pinna review frame) inject
  // <meta name="referrer" content="same-origin"> into the staging document.
  // This way any third-party asset loaded by the site (Google Tag Manager,
  // CDN images, external fonts) does NOT receive in the Referer the full
  // iframe URL (whose querystring carries the pinna_* parameters, e.g. pinna_pt).
  // 'same-origin' preserves the Referer for the site's internal assets
  // (same-origin analytics OK), blocking only cross-origin.
  if (LIVE) {
    try {
      if (!document.querySelector('meta[name="referrer"]')) {
        var refMeta = document.createElement('meta');
        refMeta.name = 'referrer';
        refMeta.content = 'same-origin';
        (document.head || document.documentElement).appendChild(refMeta);
      }
    } catch (_) { /* no-op: the staging page may have a restrictive CSP */ }
  }

  // Current viewport, derived from the width of the widget's window.
  // ProjectView fixes the iframe at 768px (tablet) and 390px (mobile).
  function currentVp() {
    var w = window.innerWidth;
    return w <= 460 ? 'mobile' : (w <= 900 ? 'tablet' : 'desktop');
  }

  // --- Robust anchoring --------------------------------------------------
  // Besides the absolute coordinates (page_x/page_y), a pin stores, when
  // possible, a CSS selector of the element under the click + a 0-1 offset
  // inside it. At render time the position is rebuilt from the element
  // (survives reflow / changed content); falls back to the absolute coordinates.
  function cssEscapeId(id) {
    return (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/[^\w-]/g, '\\$&');
  }
  // Escapes a class/value for use in a CSS selector.
  function cssEscapeTok(v) {
    return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/[^\w-]/g, '\\$&');
  }
  // A class counts as "stable" if it does not look like a volatile utility/hash:
  // it rejects classes that are too short, those with hashes (several random
  // digits/characters) and typical framework prefixes. It only serves to prefer a
  // semantic class over :nth-of-type, it need not be perfect (uniqueness is checked later).
  function looksStableClass(cn) {
    if (!cn || cn.length < 3 || cn.length > 40) return false;
    if (/^(is-|has-|js-|v-|css-|sc-|_|ng-)/.test(cn)) return false; // stateful/scoped/hash
    if (/[0-9]{4,}/.test(cn)) return false;                          // numeric hash
    if (/^[a-z]+-[a-z0-9]{6,}$/i.test(cn) && /[0-9]/.test(cn)) return false; // hashed util
    return true;
  }
  // Most robust segment for a node among its siblings with the same tag:
  // prefers a stable data-* -> a distinctive class -> :nth-of-type. Always checks
  // that the segment identifies ONE sibling only (otherwise it falls back to
  // nth-of-type). A class-based segment survives responsive reflow (which
  // reorders/adds siblings) better than nth-of-type, which breaks.
  function bestSegment(node, parent) {
    var tag = node.tagName.toLowerCase();
    var siblings = [];
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
    }
    if (siblings.length <= 1) return tag; // only one of its tag: the tag is enough
    // 1) stable data-* with a value, unique among the siblings.
    var attrs = node.attributes;
    for (var a = 0; a < attrs.length; a++) {
      var an = attrs[a].name, av = attrs[a].value;
      if (an.indexOf('data-') !== 0 || !av || an.indexOf('data-v-') === 0) continue;
      if (av.length > 60) continue;
      var seg = tag + '[' + an + '="' + av.replace(/"/g, '\\"') + '"]';
      var n = 0;
      for (var s = 0; s < siblings.length; s++) {
        if (siblings[s].getAttribute(an) === av) n++;
      }
      if (n === 1) return seg;
    }
    // 2) distinctive class, unique among the siblings.
    if (node.classList && node.classList.length) {
      for (var c = 0; c < node.classList.length; c++) {
        var cn = node.classList[c];
        if (!looksStableClass(cn)) continue;
        var m = 0;
        for (var t = 0; t < siblings.length; t++) {
          if (siblings[t].classList && siblings[t].classList.contains(cn)) m++;
        }
        if (m === 1) return tag + '.' + cssEscapeTok(cn);
      }
    }
    // 3) positional fallback.
    return tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
  }
  function cssPath(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.id) return '#' + cssEscapeId(node.id);
    var parts = [];
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 6) {
      var parent = node.parentElement;
      if (!parent) break;
      if (node.id) { parts.unshift('#' + cssEscapeId(node.id)); break; }
      parts.unshift(bestSegment(node, parent));
      node = parent;
      depth++;
    }
    return parts.length ? parts.join(' > ') : null;
  }
  // The site element under a point: the catcher is in shadow DOM on a 0x0
  // host, we hide it for an instant (synchronous, no flicker) to pick
  // the site element and not the widget.
  function elementUnder(clientX, clientY) {
    var prev = host.style.display;
    host.style.display = 'none';
    var elU = document.elementFromPoint(clientX, clientY);
    host.style.display = prev;
    return elU;
  }
  function captureAnchor(clientX, clientY) {
    var elU = elementUnder(clientX, clientY);
    if (!elU || elU === document.documentElement || elU === document.body) return null;
    var sel = cssPath(elU);
    // Longer than the server accepts (SELECTOR_MAX in worker/schemas.ts), or
    // holding a control character (a data-* value with a tab or a line feed,
    // which the server drops): no anchor, the pin falls back to its page
    // coordinates.
    if (!sel || sel.length > 1000 || /[\u0000-\u001f\u007f]/.test(sel)) return null;
    var r = elU.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return {
      selector: sel,
      x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (clientY - r.top) / r.height)),
    };
  }
  // Absolute page position of a comment. Also returns `conf`
  // (anchoring confidence) to flag uncertain pins:
  //   'anchor' = element resolved from the selector (reliable position)
  //   'scaled' = absolute fallback CORRECTED by scaling with the author's width
  //   'raw'    = raw absolute fallback (author's width unknown) = uncertain
  function commentPos(c) {
    if (c.anchor_selector) {
      var elA = null;
      try { elA = document.querySelector(c.anchor_selector); } catch (_) { elA = null; }
      if (elA) {
        var r = elA.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1) {
          var ax = c.anchor_x != null ? c.anchor_x : 0.5;
          var ay = c.anchor_y != null ? c.anchor_y : 0.5;
          return {
            x: r.left + window.scrollX + ax * r.width,
            y: r.top + window.scrollY + ay * r.height,
            conf: 'anchor',
          };
        }
      }
    }
    // Fallback: absolute coordinates saved by the author. If we know their
    // width (viewport_w) and we are in the SAME band, we scale X to the
    // current width: this reduces the drift of older pins when the author and
    // the viewer had desktop monitors of different widths. Guard: only if
    // viewport_w > 0 (older comments without it have NULL -> behavior
    // unchanged) and same band (do not scale a tablet pin on desktop).
    var px = c.page_x, py = c.page_y, conf = 'raw';
    var sameBand = (c.viewport || 'desktop') === currentVp();
    if (px != null && c.viewport_w > 0 && sameBand && window.innerWidth > 0) {
      px = px * (window.innerWidth / c.viewport_w);
      conf = 'scaled';
    }
    return { x: px, y: py, conf: conf };
  }

  // --- Store: demo (in memory) or live (Worker API) ----------------------
  var uid = function () { return 'c_' + Math.random().toString(36).slice(2, 10); };

  // Demo store: everything in memory, lasts only while the page stays open.
  var MEM = [];
  var memStore = {
    list: function () {
      return Promise.resolve(MEM.slice());
    },
    add: function (data) {
      var c = {
        id: uid(),
        parent_id: data.parent_id || null,
        page_path: PATH,
        page_x: data.page_x != null ? data.page_x : null,
        page_y: data.page_y != null ? data.page_y : null,
        anchor_selector: data.anchor_selector || null,
        anchor_x: data.anchor_x != null ? data.anchor_x : null,
        anchor_y: data.anchor_y != null ? data.anchor_y : null,
        viewport: data.parent_id ? null : currentVp(),
        mine: true,
        attachments: [],
        body: data.body,
        author: data.author,
        status: 'open',
        created_at: Date.now(),
        resolved_at: null,
      };
      MEM.push(c);
      return Promise.resolve(c);
    },
    update: function (id, patch) {
      var c = MEM.filter(function (x) { return x.id === id; })[0];
      if (!c) return Promise.resolve(null);
      if (patch.status) {
        c.status = patch.status;
        c.resolved_at = patch.status === 'done' ? Date.now() : null;
      }
      if (typeof patch.body === 'string') c.body = patch.body;
      return Promise.resolve(c);
    },
    remove: function (id) {
      MEM = MEM.filter(function (x) { return x.id !== id && x.parent_id !== id; });
      return Promise.resolve();
    },
  };

  // Live store: the same four operations against the Worker API.
  // The widget token authorizes only the project under review and travels ONLY
  // in the Authorization header (never in the URL: request URLs are readable
  // by any script on the page via performance.getEntries).
  function apiUrl(path) {
    return CFG.api + path;
  }
  function authHeaders(extra) {
    var h = { Authorization: 'Bearer ' + CFG.token };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  // --- Admin actions via the Pinna app ---------------------------------------
  // Resolving/reopening and deleting OTHER people's comments or attachments is
  // not done with the widget token: the widget asks the parent app, which shows
  // a confirmation in its own page and, if the user confirms, calls the API with
  // its session (cookie + CSRF). A site script can send the same message, but
  // it cannot click the confirmation in the app's page. Resolves true if done,
  // false if the user cancels.
  var adminSeq = 0;
  function adminViaApp(action, id, status) {
    if (!LIVE || !window.parent || window.parent === window) {
      return Promise.reject(new Error('action available only inside Pinna'));
    }
    adminSeq += 1;
    var reqId = 'adm' + adminSeq + '-' + Date.now();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        window.removeEventListener('message', handler);
        reject(new Error('pinna-admin timeout'));
      }, 180000);
      function handler(event) {
        if (event.origin !== CFG.api) return;
        var d = event.data;
        if (!d || d.type !== 'pinna-admin-result' || d.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        if (d.ok) resolve(true);
        else if (d.cancelled) resolve(false);
        else reject(new Error(typeof d.error === 'string' ? d.error : 'action failed'));
      }
      window.addEventListener('message', handler);
      var msg = { type: 'pinna-admin', reqId: reqId, action: action, id: id, pt: PROXY_PT, ch: CHANNEL };
      if (status) msg.status = status;
      try {
        window.parent.postMessage(msg, CFG.api);
      } catch (e) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        reject(e);
      }
    });
  }

  // Silent refresh: the widget token has a short TTL (1h).
  // When an API call returns 401, the widget asks the parent for a new
  // token via postMessage and repeats the call. In-flight singleton: several
  // parallel requests that hit 401 share the same refresh Promise
  // to avoid a thundering herd of refetches.
  var refreshInFlight = null;
  function requestTokenRefresh() {
    if (refreshInFlight) return refreshInFlight;
    if (!CFG.api || !window.parent || window.parent === window) {
      return Promise.reject(new Error('refresh not available outside the Pinna frame'));
    }
    refreshInFlight = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        window.removeEventListener('message', handler);
        refreshInFlight = null;
        reject(new Error('pinna-refresh timeout'));
      }, 10000);
      function handler(event) {
        if (event.origin !== CFG.api) return;
        var d = event.data;
        if (!d || d.type !== 'pinna-init') return;
        if (typeof d.token !== 'string' || !d.token) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        CFG.token = d.token;
        refreshInFlight = null;
        resolve(d.token);
      }
      window.addEventListener('message', handler);
      try {
        window.parent.postMessage({ type: 'pinna-refresh-token', pt: PROXY_PT, ch: CHANNEL }, CFG.api);
      } catch (e) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        refreshInFlight = null;
        reject(e);
      }
    });
    return refreshInFlight;
  }

  function apiSend(path, opts) { return doApiFetch(path, opts, false); }
  function doApiFetch(path, opts, isRetry) {
    // Headers rebuilt on every attempt: after a refresh the token is new.
    var o = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.headers = authHeaders(opts.headers);
    return fetch(apiUrl(path), o).then(function (r) {
      if (r.status === 401 && !isRetry) {
        return requestTokenRefresh().then(function () {
          return doApiFetch(path, opts, true);
        });
      }
      if (!r.ok) {
        var err = new Error('Pinna API ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.status === 204 ? null : r.json();
    });
  }
  var JSON_HEAD = { 'Content-Type': 'application/json' };
  // An API comment row -> the shape used by the widget.
  function mapRow(c) {
    return {
      id: c.id,
      parent_id: c.parent_id || null,
      page_path: c.page_path || '',
      page_x: c.page_x != null ? c.page_x : null,
      page_y: c.page_y != null ? c.page_y : null,
      anchor_selector: c.anchor_selector || null,
      anchor_x: c.anchor_x != null ? c.anchor_x : null,
      anchor_y: c.anchor_y != null ? c.anchor_y : null,
      // Exact width of the author's window: commentPos needs it to scale
      // the absolute fallback. Dropping it would cause pin drift.
      viewport_w: c.viewport_w != null ? c.viewport_w : null,
      body: c.body,
      author: c.author_role === 'admin' ? 'admin' : c.author_role === 'collab' ? 'collab' : 'client',
      status: c.status === 'done' ? 'done' : 'open',
      viewport: c.viewport || null,
      mine: !!c.mine,
      attachments: c.attachments || [],
      created_at: c.created_at,
      resolved_at: c.resolved_at != null ? c.resolved_at : null,
    };
  }
  var apiStore = {
    list: function () {
      return apiSend(
        '/api/projects/' + encodeURIComponent(CFG.project) + '/comments',
        { method: 'GET' },
      ).then(function (rows) { return (rows || []).map(mapRow); });
    },
    add: function (data) {
      return apiSend(
        '/api/projects/' + encodeURIComponent(CFG.project) + '/comments',
        {
          method: 'POST',
          headers: JSON_HEAD,
          body: JSON.stringify({
            parent_id: data.parent_id || null,
            page_path: data.parent_id ? '' : PATH,
            page_x: data.page_x != null ? data.page_x : null,
            page_y: data.page_y != null ? data.page_y : null,
            anchor_selector: data.anchor_selector || null,
            anchor_x: data.anchor_x != null ? data.anchor_x : null,
            anchor_y: data.anchor_y != null ? data.anchor_y : null,
            viewport_w: window.innerWidth,
            viewport: data.parent_id ? null : currentVp(),
            attachment_ids: data.attachment_ids || [],
            body: data.body,
          }),
        },
      ).then(function (c) { return { id: c.id }; });
    },
    update: function (id, patch) {
      // A status change is an admin action: the app does it (see adminViaApp).
      if (patch && patch.status !== undefined) return adminViaApp('status', id, patch.status);
      return apiSend('/api/comments/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: JSON_HEAD,
        body: JSON.stringify(patch),
      });
    },
    remove: function (id, mine) {
      // Someone else's comment, or a thread holding someone else's reply: the app
      // deletes it (session + confirmation), not the token.
      if (mine === false) return adminViaApp('delete-comment', id);
      return apiSend('/api/comments/' + encodeURIComponent(id), { method: 'DELETE' });
    },
  };

  var store = LIVE ? apiStore : memStore;

  // Demo seed: two example threads, only in demo mode (never on the real API).
  if (!LIVE) {
    MEM.push({
      id: 'c_demo1', parent_id: null, page_path: PATH, viewport: 'desktop', page_x: 600, page_y: 340,
      body: 'Could this image be a bit larger? It gets lost among the text.',
      author: 'client', mine: ME === 'client', attachments: [], status: 'open',
      created_at: Date.now() - 1000 * 60 * 42, resolved_at: null,
    });
    MEM.push({
      id: 'c_demo2', parent_id: 'c_demo1', page_path: PATH, page_x: null, page_y: null,
      body: 'Agreed, I will take it to 130% and separate it from the paragraph. Fixed in the next round.',
      author: 'admin', mine: ME === 'admin', attachments: [], status: 'open',
      created_at: Date.now() - 1000 * 60 * 30, resolved_at: null,
    });
  }

  // --- Runtime state -----------------------------------------------------
  var state = {
    comments: [],
    mode: false,      // true = comment mode (catcher active)
    popEl: null,      // open popover, or null
    openId: null,     // id of the pin with an open popover
    tab: 'open',      // sidebar tab: 'open' | 'done'
    sidebar: false,   // sidebar open?
    draftEl: null,    // dot of the comment being created
    search: '',       // sidebar text filter
    author: 'all',    // sidebar author filter ('all' | 'admin' | 'client')
  };
  // Map of comment id -> rendered pin node (for the pulse/flash on jump).
  var pinNodes = {};

  // --- Helpers ------------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k === 'html') n.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    }
    if (kids != null) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c == null || c === false) return;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return n;
  }

  function relTime(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 50) return t('rel_now');
    var m = Math.round(s / 60);
    if (m < 60) return t('rel_min', m);
    var h = Math.round(m / 60);
    if (h < 24) return t('rel_hour', h);
    var d = Math.round(h / 24);
    if (d < 7) return t('rel_day', d);
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // Icons: minimal inline SVG, currentColor (no emoji, a design rule).
  var ICON = {
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 15.6A2.4 2.4 0 0 1 17.6 18H8.4L4 21.4V6.4A2.4 2.4 0 0 1 6.4 4h11.2A2.4 2.4 0 0 1 20 6.4Z"/><path d="M8.4 9.4h7.2M8.4 12.9h4.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.6" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.6" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6 9 12l6 6"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M8.6 14.3c.7 1 1.9 1.7 3.4 1.7s2.7-.7 3.4-1.7"/><path d="M9 9.7h.01M15 9.7h.01"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  };

  // Pinna logo (wordmark) in color, for the comments sidebar header.
  var WORDMARK =
    '<svg viewBox="9 -732 2775 744" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="pinna-wm" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#0066cc"/><stop offset="1" stop-color="#00aaff"/>' +
    '</linearGradient></defs><path fill="url(#pinna-wm)" d="M84 5Q49 5 29-13Q9-31 9-64Q9-75 12-90L109-548Q120-599 150.500-623Q181-647 231-647L380-647Q506-647 572.500-597Q639-547 639-449Q639-327 562.500-254.500Q486-182 332-182L233-182L212-87Q202-40 178.500-17.500Q155 5 113 5L84 5M261-328L344-328Q391-328 418-354Q445-380 445-429Q445-462 423-479.500Q401-497 358-497L296-497L261-328M843-550Q799-550 772.500-572.500Q746-595 746-634Q746-676 776-704Q806-732 855-732Q897-732 924-710Q951-688 951-649Q951-606 921.500-578Q892-550 843-550M764 12Q700 12 670.500-16Q641-44 641-94Q641-114 646-142L704-408Q714-459 734-479.500Q754-500 791-500L811-500Q849-500 873-484.500Q897-469 897-434Q897-423 894-408L836-134Q831-114 831-93Q831-72 840-60Q849-48 868-42Q871-41 861.500-26.500Q852-12 828.500 0Q805 12 764 12M1492-56Q1496-55 1485-36.500Q1474-18 1448.500-3Q1423 12 1380 12Q1319 12 1290.500-13.500Q1262-39 1262-85Q1262-107 1267-132.500Q1272-158 1285-202Q1304-275 1304-293Q1304-321 1288.500-337Q1273-353 1245-353Q1220-353 1203-342.500Q1186-332 1169-309L1121-87Q1111-36 1090.500-15.500Q1070 5 1033 5L1013 5Q976 5 951.500-11Q927-27 927-62Q927-74 930-87L1015-487Q1016-491 1032.500-495.500Q1049-500 1070-500Q1100-500 1125-486.500Q1150-473 1163-446Q1171-428 1174-406Q1209-455 1252.500-481.500Q1296-508 1353-508Q1425-508 1465-465.500Q1505-423 1505-352Q1505-327 1498.500-294.500Q1492-262 1477-210Q1453-128 1453-103Q1453-82 1462.500-71.500Q1472-61 1492-56M2107-56Q2111-55 2100-36.500Q2089-18 2063.500-3Q2038 12 1995 12Q1934 12 1905.500-13.500Q1877-39 1877-85Q1877-107 1882-132.500Q1887-158 1900-202Q1919-275 1919-293Q1919-321 1903.500-337Q1888-353 1860-353Q1835-353 1818-342.500Q1801-332 1784-309L1736-87Q1726-36 1705.500-15.500Q1685 5 1648 5L1628 5Q1591 5 1566.500-11Q1542-27 1542-62Q1542-74 1545-87L1630-487Q1631-491 1647.500-495.500Q1664-500 1685-500Q1715-500 1740-486.500Q1765-473 1778-446Q1786-428 1789-406Q1824-455 1867.500-481.500Q1911-508 1968-508Q2040-508 2080-465.500Q2120-423 2120-352Q2120-327 2113.500-294.500Q2107-262 2092-210Q2068-128 2068-103Q2068-82 2077.500-71.500Q2087-61 2107-56M2349 12Q2268 12 2218-42Q2168-96 2168-186Q2168-269 2202-343Q2236-417 2297-462.500Q2358-508 2436-508Q2485-508 2527-485Q2569-462 2589-419Q2608-461 2640-481Q2671-500 2718-500Q2743-500 2763.500-491.500Q2784-483 2783-477L2710-134Q2705-114 2705-93Q2705-72 2713.500-60Q2722-48 2741-42Q2744-41 2734.500-26.500Q2725-12 2702.500 0Q2680 12 2641 12Q2569 12 2540-33Q2526-55 2523-90Q2496-43 2450.500-15.500Q2405 12 2349 12M2428-137Q2470-137 2501-165Q2532-193 2542-240L2554-300Q2531-363 2469-363Q2417-363 2384.500-320Q2352-277 2352-219Q2352-182 2373-159.500Q2394-137 2428-137"/></svg>';

  // --- Emoji --------------------------------------------------------------
  var EMOJI = [
    '👍', '👎', '✅', '❌', '🔥', '⭐', '💡', '⚠️',
    '👀', '🎉', '✨', '💯', '❤️', '👏', '🙏', '💪',
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
    '🙂', '🙃', '😉', '😊', '😇', '😍', '🥰', '😘',
    '😋', '😛', '😜', '🤪', '😎', '🤩', '🥳', '🤗',
    '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😒',
    '😬', '😴', '😕', '🙁', '😟', '😔', '😞', '😣',
    '😫', '😩', '😢', '😭', '😤', '😠', '😡', '😱',
    '👌', '✌️', '🤞', '🤙', '👋', '🙌', '🤝', '✊',
    '✏️', '📝', '📌', '📎', '🔗', '🖼️', '🎨', '📷',
    '📱', '💻', '➡️', '⬆️', '⬇️', '🟢', '🔴', '🟡',
  ];

  // Emoji button + panel: inserts the emoji at the cursor position.
  function emojiPicker(textarea) {
    var panel = el(
      'div',
      { class: 'emoji-panel' },
      EMOJI.map(function (e) {
        return el('button', {
          class: 'emoji', type: 'button', text: e, 'aria-label': t('emoji_aria', e),
          onclick: function (ev) {
            ev.preventDefault();
            var s = textarea.selectionStart || 0;
            var en = textarea.selectionEnd || 0;
            textarea.value = textarea.value.slice(0, s) + e + textarea.value.slice(en);
            var pos = s + e.length;
            textarea.setSelectionRange(pos, pos);
            textarea.focus();
            wrap.classList.remove('open');
          },
        });
      }),
    );
    var btn = el('button', {
      class: 'emoji-btn', type: 'button', 'aria-label': t('emoji_insert'),
      html: ICON.smile,
      onclick: function (ev) {
        ev.preventDefault();
        wrap.classList.toggle('open');
      },
    });
    var wrap = el('div', { class: 'emoji-wrap' }, [btn, panel]);
    return wrap;
  }

  // --- Attachments -------------------------------------------------------
  // Uploads a file to the API, returns the attachment metadata.
  // On 401, retry once after refreshing the token. FormData is
  // rebuilt on every attempt because the previous fetch body is consumed.
  function uploadFile(file) { return doUpload(file, false); }
  function doUpload(file, isRetry) {
    var fd = new FormData();
    fd.append('file', file);
    return fetch(
      apiUrl('/api/projects/' + encodeURIComponent(CFG.project) + '/attachments'),
      { method: 'POST', body: fd, headers: authHeaders() },
    ).then(function (r) {
      if (r.status === 401 && !isRetry) {
        return requestTokenRefresh().then(function () {
          return doUpload(file, true);
        });
      }
      if (!r.ok) throw new Error('upload ' + r.status);
      return r.json();
    });
  }
  // Deletes an attachment server-side (R2 blob + D1 record). The upload is
  // fire-on-select: when the client removes a file from the draft the blob
  // already exists, so the X MUST call the real DELETE (otherwise the blob
  // would stay orphaned forever). 401 -> refresh token + retry once.
  function deleteAttachmentReq(id, isRetry) {
    return fetch(
      apiUrl('/api/attachments/' + encodeURIComponent(id)),
      { method: 'DELETE', headers: authHeaders() },
    ).then(function (r) {
      if (r.status === 401 && !isRetry) {
        return requestTokenRefresh().then(function () {
          return deleteAttachmentReq(id, true);
        });
      }
      if (!r.ok && r.status !== 404) {
        var err = new Error('delete att ' + r.status);
        err.status = r.status;
        throw err;
      }
      return true;
    });
  }

  // Attachment control of a composer: paperclip button + file input +
  // bar of pending files. ids() returns the ids to send with the comment.
  function attachUI() {
    var pending = [];
    var bar = el('div', { class: 'atts' });
    var input = el('input', { type: 'file', multiple: 'multiple', class: 'att-input' });
    function renderBar() {
      bar.innerHTML = '';
      bar.style.display = pending.length ? 'flex' : 'none';
      pending.forEach(function (a) {
        bar.appendChild(el('span', { class: 'att-chip' + (a.up ? ' up' : '') }, [
          el('span', { class: 'att-name', text: a.up ? 'Uploading...' : a.filename }),
          a.up ? null : el('button', {
            class: 'att-x', type: 'button', 'aria-label': t('attach_remove'),
            html: ICON.close,
            onclick: function () {
              pending = pending.filter(function (x) { return x !== a; });
              renderBar();
              // The upload has already happened (fire-on-select): delete the
              // orphan blob server-side, not just from the local array.
              if (a.id) {
                deleteAttachmentReq(a.id).catch(function (e) {
                  console.warn('[pinna] deleting draft attachment failed:', e && e.message);
                });
              }
            },
          }),
        ]));
      });
    }
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      files.forEach(function (f) {
        var slot = { up: true, filename: f.name };
        pending.push(slot);
        renderBar();
        uploadFile(f).then(function (att) {
          slot.up = false;
          slot.id = att.id;
          slot.filename = att.filename;
          renderBar();
        }).catch(function (e) {
          pending = pending.filter(function (x) { return x !== slot; });
          renderBar();
          console.warn('[pinna] upload failed:', e && e.message);
        });
      });
    });
    var button = el('button', {
      class: 'att-btn', type: 'button', 'aria-label': t('attach_aria'),
      html: ICON.clip,
      onclick: function () { input.click(); },
    });
    renderBar();
    return {
      bar: bar,
      input: input,
      button: button,
      ids: function () {
        return pending
          .filter(function (a) { return a.id; })
          .map(function (a) { return a.id; });
      },
    };
  }

  // --- Shadow DOM ---------------------------------------------------------
  var host = document.createElement('div');
  host.id = 'pinna-host';
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;';
  var root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  // --- Screenshot with the comment (server-side, "like Markup") ----------
  // On dynamic content (modal, carousel, text revealed on click) the pin alone
  // does not say WHICH state the client was seeing. To capture it the widget
  // SERIALIZES the EXACT DOM the client is looking at (open pill, modal, carousel
  // slide) and sends it to the SERVER as `html`. A headless Chrome (Cloudflare
  // Browser Run) does setContent of that snapshot and takes a REAL
  // screenshot, pixel-perfect (real fonts and images, no CORS problems), with the
  // dot exactly where the client clicked, saved as an R2 attachment. The snapshot
  // PRESERVES the dynamic state: the server does setContent of the serialized DOM,
  // not a reload (which would reset pills/modals to their default state). The
  // <script> tags are removed by the server (no JS that resets the state). `url`
  // stays as a fallback if serialization fails. No browser-side rasterization
  // (a client-side reconstruction renders differently). Soft fallback: if the
  // screenshot fails, the comment is still saved without a photo. Returns the
  // attachment {id,...} (already saved server-side) or rejects.
  function serializeViewportDom() {
    try {
      // Clone <html> and remove the widget host (the shadow DOM is not
      // serialized by outerHTML, but the host div is removed anyway for cleanliness).
      var docEl = document.documentElement.cloneNode(true);
      var hostClone = docEl.querySelector('#pinna-host');
      if (hostClone && hostClone.parentNode) hostClone.parentNode.removeChild(hostClone);
      return '<!doctype html>\n' + docEl.outerHTML;
    } catch (e) {
      return null;
    }
  }
  function requestServerShot(mx, my) {
    var bodyObj = {
      html: serializeViewportDom(),
      url: location.href,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      sx: window.scrollX || window.pageXOffset || 0,
      sy: window.scrollY || window.pageYOffset || 0,
      mx: mx,
      my: my,
    };
    function attempt(isRetry) {
      return fetch(
        apiUrl('/api/projects/' + encodeURIComponent(CFG.project) + '/shot'),
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(bodyObj),
        },
      ).then(function (r) {
        if (r.status === 401 && !isRetry) {
          return requestTokenRefresh().then(function () { return attempt(true); });
        }
        if (!r.ok) throw new Error('shot ' + r.status);
        return r.json();
      });
    }
    // Anti-hang guard: the server-side screenshot must NOT block the comment.
    // ~25s ceiling (Chrome can take a few seconds); beyond that, we give up
    // and the caller does .catch -> null = comment without a photo.
    var timeout = new Promise(function (_res, rej) {
      setTimeout(function () { rej(new Error('shot timeout')); }, 25000);
    });
    return Promise.race([attempt(false), timeout]);
  }

  var CSS = [
    /* Tokens: light theme, blue accent. */
    ':host{ all:initial;',
    '  --bg:#ffffff; --bg-2:#f1f5f9; --bg-3:#f8fafc;',
    '  --text:#1e293b; --text-2:#475569; --text-3:#94a3b8;',
    '  --line:#e2e8f0; --line-2:#cbd5e1;',
    '  --accent:#0066cc; --accent-hi:#0088e6;',
    '  --grad:linear-gradient(135deg,#0066cc 0%,#00aaff 100%);',
    '  --tint:#e8f2fc; --tint-green:#dcfce7;',
    '  --success:#16a34a; --danger:#dc2626;',
    '  --ease:cubic-bezier(0.23,1,0.32,1); }',
    '*{ box-sizing:border-box; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }',
    '::-webkit-scrollbar{ width:8px; height:8px; }',
    '::-webkit-scrollbar-track{ background:transparent; }',
    '::-webkit-scrollbar-thumb{ background:var(--line-2); border-radius:4px; }',

    '.layer{ position:absolute; top:0; left:0; z-index:2; }',
    '.catcher{ position:fixed; inset:0; z-index:4; display:none; cursor:crosshair;',
    '  background:rgba(0,102,204,0.045); }',
    '.catcher.on{ display:block; }',
    '.frame{ position:fixed; inset:0; z-index:3; display:none; pointer-events:none;',
    '  box-shadow:inset 0 0 0 2.5px rgba(0,102,204,0.5); }',
    '.frame.on{ display:block; }',

    /* --- Pin --- */
    '.pin{ position:absolute; width:28px; height:28px; margin:-14px 0 0 -14px;',
    '  border-radius:50%; border:2.5px solid #ffffff;',
    '  background:var(--grad); color:#ffffff;',
    '  font-size:12px; font-weight:700; font-variant-numeric:tabular-nums;',
    '  display:flex; align-items:center; justify-content:center; cursor:pointer;',
    '  box-shadow:0 3px 10px -1px rgba(15,23,42,0.35), 0 1px 3px rgba(15,23,42,0.2);',
    '  padding:0; transition:transform .16s var(--ease); }',
    '.pin:hover{ transform:scale(1.14); }',
    '.pin:focus-visible{ outline:none;',
    '  box-shadow:0 0 0 4px rgba(0,102,204,0.3), 0 3px 10px -1px rgba(15,23,42,0.35); }',
    '.pin.done{ background:var(--success); }',
    '.pin.sel{ box-shadow:0 0 0 4px rgba(0,102,204,0.28), 0 4px 12px -1px rgba(15,23,42,0.4); }',
    /* Uncertain pin (raw fallback): dashed border = approximate position. */
    '.pin.approx{ border-style:dashed; opacity:0.82; }',
    '.pin.appear{ animation:pinIn .26s var(--ease); }',
    '.pin.flash{ animation:pinFlash 1s var(--ease) 2; }',
    '.pin svg{ width:15px; height:15px; }',
    '@keyframes pinIn{ from{ opacity:0; transform:scale(0.55); } to{ opacity:1; transform:scale(1); } }',
    '@keyframes pinFlash{ 0%,100%{ box-shadow:0 0 0 4px rgba(0,102,204,0.32), 0 4px 12px -1px rgba(15,23,42,0.4); }',
    '  50%{ box-shadow:0 0 0 13px rgba(0,102,204,0), 0 4px 12px -1px rgba(15,23,42,0.4); } }',
    '.draft{ position:absolute; width:18px; height:18px; margin:-9px 0 0 -9px; border-radius:50%;',
    '  background:var(--grad); border:2px solid #fff;',
    '  box-shadow:0 0 0 5px rgba(0,102,204,0.18); animation:pulse 1.4s ease-in-out infinite; }',
    '@keyframes pulse{ 0%,100%{ box-shadow:0 0 0 5px rgba(0,102,204,0.2); }',
    '  50%{ box-shadow:0 0 0 11px rgba(0,102,204,0.05); } }',

    /* --- FAB (new comment) --- */
    '.fab{ position:fixed; right:22px; bottom:22px; z-index:8;',
    '  display:flex; align-items:center; gap:8px; height:46px; padding:0 17px 0 14px;',
    '  border-radius:999px; border:1px solid var(--line);',
    '  background:var(--bg); color:var(--text);',
    '  font-size:14px; font-weight:560; cursor:pointer;',
    '  box-shadow:0 8px 24px -8px rgba(15,23,42,0.28), 0 1px 2px rgba(15,23,42,0.06);',
    '  transition:transform .14s var(--ease), border-color .14s ease, box-shadow .14s ease; }',
    '.fab:hover{ border-color:var(--line-2); transform:translateY(-1px);',
    '  box-shadow:0 10px 26px -8px rgba(15,23,42,0.32); }',
    '.fab:active{ transform:scale(0.97); }',
    '.fab:focus-visible{ outline:none; border-color:var(--accent);',
    '  box-shadow:0 0 0 4px rgba(0,102,204,0.22); }',
    '.fab svg{ width:19px; height:19px; color:var(--accent); }',
    '.fab.active{ background:var(--grad); border-color:transparent; color:#ffffff;',
    '  box-shadow:0 8px 24px -6px rgba(0,102,204,0.5); }',
    '.fab.active svg{ color:#ffffff; }',

    /* --- Hint --- */
    '.hint{ position:fixed; right:22px; bottom:80px; z-index:8;',
    '  max-width:232px; padding:10px 13px; border-radius:11px;',
    '  background:var(--bg); border:1px solid var(--line);',
    '  color:var(--text-2); font-size:12.5px; line-height:1.45;',
    '  box-shadow:0 10px 28px -10px rgba(15,23,42,0.3);',
    '  opacity:0; transform:translateY(6px); pointer-events:none;',
    '  transition:opacity .2s ease, transform .2s var(--ease); }',
    '.hint.on{ opacity:1; transform:translateY(0); }',
    '.hint b{ color:var(--text); font-weight:650; }',

    /* --- Handle (opens the sidebar) --- */
    '.handle{ position:fixed; left:22px; bottom:22px; z-index:8;',
    '  display:flex; align-items:center; gap:8px; height:46px; padding:0 16px 0 14px;',
    '  border-radius:999px; border:1px solid var(--line);',
    '  background:var(--bg); color:var(--text);',
    '  font-size:14px; font-weight:560; cursor:pointer;',
    '  box-shadow:0 8px 24px -8px rgba(15,23,42,0.28), 0 1px 2px rgba(15,23,42,0.06);',
    '  transition:transform .14s var(--ease), border-color .14s ease, opacity .18s ease; }',
    '.handle:hover{ border-color:var(--line-2); transform:translateY(-1px); }',
    '.handle:active{ transform:scale(0.97); }',
    '.handle:focus-visible{ outline:none; border-color:var(--accent);',
    '  box-shadow:0 0 0 4px rgba(0,102,204,0.22); }',
    '.handle svg{ width:18px; height:18px; color:var(--accent); }',
    '.handle .count{ min-width:20px; height:20px; padding:0 6px; border-radius:999px;',
    '  background:var(--grad); color:#ffffff;',
    '  font-size:11px; font-weight:700; font-variant-numeric:tabular-nums;',
    '  display:flex; align-items:center; justify-content:center; }',
    '.handle.hidden{ opacity:0; transform:translateY(10px); pointer-events:none; }',

    /* --- Sidebar --- */
    '.sb{ position:fixed; left:0; top:0; bottom:0; width:312px; z-index:9;',
    '  display:flex; flex-direction:column;',
    '  background:var(--bg); border-right:1px solid var(--line);',
    '  box-shadow:16px 0 48px -22px rgba(15,23,42,0.28);',
    '  transform:translateX(-100%); transition:transform .26s var(--ease); }',
    '.sb.open{ transform:translateX(0); }',
    '.sb-head{ display:flex; align-items:center; gap:10px; padding:16px 12px 14px 17px;',
    '  border-bottom:1px solid var(--line); }',
    '.sb-fin svg{ width:18px; height:18px; color:var(--accent); display:block; }',
    '.sb-brand{ font-size:15px; font-weight:720; letter-spacing:-0.01em; color:var(--text); }',
    '.sb-logo svg{ height:21px; width:auto; display:block; }',
    /* Italic logo: small nudge to the left to align it with the text below. */
    '.sb-logo{ margin-bottom:3px; margin-left:-2px; }',
    '.sb-sub{ font-size:11.5px; color:var(--text-3); margin-top:1px; }',
    '.sb-tabs{ display:flex; gap:4px; padding:11px 12px 3px; }',
    '.tab{ flex:1; height:35px; border:0; border-radius:8px; cursor:pointer;',
    '  background:transparent; color:var(--text-2);',
    '  font-size:13px; font-weight:600; display:flex; align-items:center;',
    '  justify-content:center; gap:7px; transition:background .14s ease, color .14s ease,',
    '  box-shadow .14s ease; }',
    '.tab:hover{ background:var(--bg-2); color:var(--text); }',
    '.tab.on{ background:var(--bg-2); color:var(--text);',
    '  box-shadow:inset 0 -2px 0 var(--accent); }',
    '.tab:focus-visible{ outline:none; box-shadow:0 0 0 3px rgba(0,102,204,0.28); }',
    '.tab .n{ font-size:11px; font-weight:700; font-variant-numeric:tabular-nums;',
    '  min-width:19px; height:18px; padding:0 5px; border-radius:999px;',
    '  display:flex; align-items:center; justify-content:center;',
    '  background:var(--line); color:var(--text-2); }',
    '.tab.on .n{ background:var(--tint); color:var(--accent); }',
    /* --- Search + author filter --- */
    '.sb-search{ padding:6px 12px 4px; display:flex; flex-direction:column; gap:6px; }',
    '.sb-search-input{ width:100%; height:32px; padding:0 10px; border-radius:8px;',
    '  border:1px solid var(--line); background:var(--bg-3); color:var(--text);',
    '  font-size:13px; }',
    '.sb-search-input::placeholder{ color:var(--text-3); }',
    '.sb-search-input:focus{ outline:none; border-color:var(--accent);',
    '  box-shadow:0 0 0 3px rgba(0,102,204,0.13); }',
    '.sb-filter{ display:flex; gap:4px; }',
    '.sb-fbtn{ flex:1; height:28px; border:1px solid var(--line); border-radius:7px;',
    '  background:transparent; color:var(--text-2); font-size:12px; font-weight:600;',
    '  cursor:pointer; transition:background .13s ease, color .13s ease, border-color .13s ease; }',
    '.sb-fbtn:hover{ background:var(--bg-2); color:var(--text); }',
    '.sb-fbtn.on{ background:var(--tint); color:var(--accent); border-color:transparent; }',
    '.sb-fbtn:focus-visible{ outline:none; box-shadow:0 0 0 2px rgba(0,102,204,0.35); }',
    '.sb-list{ flex:1; overflow-y:auto; padding:8px 8px 14px; }',
    '.sb-page{ display:flex; align-items:center; justify-content:space-between; gap:8px;',
    '  width:100%; text-align:left; border:0; cursor:pointer; background:transparent;',
    '  padding:13px 10px 5px; margin-top:3px; }',
    '.sb-page:hover .sb-page-go{ color:var(--accent-hi); }',
    '.sb-page-path{ font-size:11px; font-weight:700; letter-spacing:.01em; color:var(--text-3);',
    '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.sb-page-go{ flex:none; font-size:10.5px; font-weight:650; color:var(--accent); }',
    '.sb-item{ display:grid; grid-template-columns:24px 1fr; gap:11px;',
    '  width:100%; text-align:left; padding:11px 10px; border:0; cursor:pointer;',
    '  border-radius:10px; background:transparent; transition:background .13s ease; }',
    '.sb-item + .sb-item{ margin-top:2px; }',
    '.sb-item:hover{ background:var(--bg-2); }',
    '.sb-item:focus-visible{ outline:none; box-shadow:0 0 0 2px rgba(0,102,204,0.4); }',
    '.sb-num{ width:24px; height:24px; border-radius:50%;',
    '  background:var(--grad); color:#ffffff;',
    '  font-size:11.5px; font-weight:700; font-variant-numeric:tabular-nums;',
    '  display:flex; align-items:center; justify-content:center; margin-top:1px; }',
    '.sb-num.done{ background:var(--success); }',
    '.sb-num svg{ width:13px; height:13px; }',
    '.sb-body{ font-size:13px; line-height:1.5; color:var(--text);',
    '  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;',
    '  overflow:hidden; }',
    '.sb-meta{ margin-top:5px; display:flex; align-items:center; gap:7px;',
    '  font-size:11px; color:var(--text-3); }',
    '.sb-empty{ padding:40px 26px; text-align:center; color:var(--text-3);',
    '  font-size:12.5px; line-height:1.55; }',
    '.sb-empty b{ display:block; color:var(--text-2); font-weight:650;',
    '  font-size:13.5px; margin-bottom:4px; }',

    /* --- Popover --- */
    '.pop{ position:absolute; width:320px; z-index:6;',
    '  background:var(--bg); border:1px solid var(--line);',
    '  border-radius:15px; color:var(--text);',
    '  box-shadow:0 18px 48px -14px rgba(15,23,42,0.32), 0 2px 8px rgba(15,23,42,0.08);',
    '  opacity:0; transform:scale(0.96); }',
    '.pop.in{ opacity:1; transform:scale(1);',
    '  transition:opacity .17s ease, transform .19s var(--ease); }',
    '.pop-head{ display:flex; align-items:center; gap:8px; padding:12px 12px 10px 14px;',
    '  border-bottom:1px solid var(--line); }',
    '.pop-fin{ display:flex; }',
    '.pop-fin svg{ width:14px; height:14px; color:var(--accent); }',
    '.pop-title{ font-size:12px; font-weight:650; letter-spacing:.03em;',
    '  color:var(--text-3); text-transform:uppercase; }',
    '.pop-num{ font-size:12px; font-weight:700; color:var(--text);',
    '  font-variant-numeric:tabular-nums; }',
    '.badge{ margin-left:auto; display:inline-flex; align-items:center;',
    '  padding:3px 9px; border-radius:999px; font-size:11px; font-weight:650; }',
    '.badge.open{ background:var(--tint); color:var(--accent); }',
    '.badge.done{ background:var(--tint-green); color:var(--success); }',
    '.x{ display:flex; width:26px; height:26px; align-items:center; justify-content:center;',
    '  border:0; border-radius:7px; background:transparent; color:var(--text-3);',
    '  cursor:pointer; transition:background .14s ease, color .14s ease; }',
    '.x:hover{ background:var(--bg-2); color:var(--text); }',
    '.x svg{ width:15px; height:15px; }',
    '.thread{ max-height:260px; overflow-y:auto; padding:4px 0; }',
    '.msg{ padding:11px 14px; }',
    '.msg + .msg{ border-top:1px solid var(--line); }',
    '.msg-top{ display:flex; align-items:center; gap:7px; margin-bottom:5px; }',
    '.who{ font-size:11px; font-weight:700; padding:2px 7px; border-radius:6px; }',
    '.who.client{ background:var(--bg-2); color:var(--text-2); }',
    '.who.admin{ background:var(--tint); color:var(--accent); }',
    '.who.collab{ background:var(--tint); color:var(--accent); }',
    '.when{ font-size:11px; color:var(--text-3); }',
    '.msg-body{ font-size:13.5px; line-height:1.5; color:var(--text);',
    '  white-space:pre-wrap; word-break:break-word; }',
    '.msg-edit{ margin-left:auto; border:0; background:transparent; cursor:pointer;',
    '  font-size:11px; font-weight:600; color:var(--text-3); padding:2px 5px;',
    '  border-radius:5px; }',
    '.msg-edit:hover{ color:var(--accent); background:var(--bg-2); }',
    '.edit-ta{ width:100%; min-height:56px; resize:vertical; padding:8px 10px;',
    '  border-radius:9px; border:1px solid var(--accent);',
    '  background:var(--bg-3); color:var(--text); font-size:13.5px; line-height:1.5;',
    '  box-shadow:0 0 0 3px rgba(0,102,204,0.13); }',
    '.edit-ta:focus{ outline:none; }',
    '.edit-row{ display:flex; justify-content:flex-end; gap:7px; margin-top:8px; }',
    '.mini{ height:30px; padding:0 13px; border-radius:8px; cursor:pointer;',
    '  font-size:12.5px; font-weight:650; border:1px solid var(--line);',
    '  background:var(--bg); color:var(--text-2); transition:background .14s ease; }',
    '.mini:hover{ background:var(--bg-2); }',
    '.mini-go{ background:var(--grad); color:#fff; border-color:transparent; }',
    '.mini-go:hover{ background:var(--grad); color:#fff;',
    '  box-shadow:0 3px 10px -2px rgba(0,102,204,0.45); }',
    '.foot{ padding:11px 14px 13px; border-top:1px solid var(--line); }',
    '.pop-err{ margin:0 0 9px; padding:7px 10px; border-radius:8px;',
    '  background:#fef2f2; color:var(--danger); font-size:12.5px; line-height:1.4; }',
    '.field{ display:flex; flex-direction:column; gap:7px; }',
    '.field label{ font-size:11px; font-weight:650; letter-spacing:.03em;',
    '  text-transform:uppercase; color:var(--text-3); }',
    'textarea{ width:100%; min-height:62px; resize:vertical; padding:9px 10px;',
    '  border-radius:9px; border:1px solid var(--line);',
    '  background:var(--bg-3); color:var(--text);',
    '  font-size:13.5px; line-height:1.5; }',
    'textarea::placeholder{ color:var(--text-3); }',
    'textarea:focus{ outline:none; border-color:var(--accent);',
    '  box-shadow:0 0 0 3px rgba(0,102,204,0.13); }',
    '.row{ display:flex; align-items:center; gap:8px; margin-top:10px; }',
    '.btn{ height:34px; padding:0 14px; border-radius:8px; font-size:13px;',
    '  font-weight:650; cursor:pointer; border:1px solid transparent;',
    '  transition:transform .12s ease, background .14s ease, border-color .14s ease,',
    '  box-shadow .14s ease; }',
    '.btn:active{ transform:scale(0.97); }',
    '.btn:focus-visible{ outline:none; box-shadow:0 0 0 3px rgba(0,102,204,0.3); }',
    '.btn-primary{ background:var(--grad); color:#ffffff;',
    '  box-shadow:0 3px 10px -2px rgba(0,102,204,0.4); }',
    '.btn-primary:hover{ box-shadow:0 5px 14px -2px rgba(0,102,204,0.5); }',
    '.btn-ghost{ background:var(--bg); border-color:var(--line);',
    '  color:var(--text-2); }',
    '.btn-ghost:hover{ background:var(--bg-2); color:var(--text); }',
    '.btn-done{ background:var(--success); color:#ffffff; }',
    '.btn-done:hover{ background:#15873f; }',
    '.btn-block{ display:flex; width:100%; align-items:center;',
    '  justify-content:center; margin-top:9px; }',
    '.spacer{ flex:1; }',
    '.del{ background:transparent; border:0; cursor:pointer; font-size:12px;',
    '  font-weight:560; color:var(--text-3); padding:6px 4px;',
    '  transition:color .14s ease; }',
    '.del:hover{ color:var(--danger); }',
    '.btn svg{ width:15px; height:15px; vertical-align:-3px; margin-right:3px; }',
    '.emoji-wrap{ position:relative; display:flex; }',
    '.emoji-btn{ display:flex; align-items:center; justify-content:center;',
    '  width:34px; height:34px; border-radius:8px; border:1px solid var(--line);',
    '  background:var(--bg); color:var(--text-3); cursor:pointer;',
    '  transition:background .14s ease, color .14s ease; }',
    '.emoji-btn:hover{ background:var(--bg-2); color:var(--text); }',
    '.emoji-btn:focus-visible{ outline:none; box-shadow:0 0 0 3px rgba(0,102,204,0.3); }',
    '.emoji-btn svg{ width:18px; height:18px; }',
    '.emoji-panel{ display:none; position:absolute; bottom:42px; left:0; z-index:7;',
    '  width:236px; padding:8px; background:var(--bg); border:1px solid var(--line);',
    '  border-radius:12px; box-shadow:0 14px 34px -12px rgba(15,23,42,0.34);',
    '  grid-template-columns:repeat(8,1fr); gap:1px;',
    '  max-height:252px; overflow-y:auto; }',
    '.emoji-wrap.open .emoji-panel{ display:grid; }',
    '.emoji{ border:0; background:transparent; cursor:pointer; font-size:17px;',
    '  line-height:1; padding:5px 0; border-radius:6px; }',
    '.emoji:hover{ background:var(--bg-2); }',
    '.att-input{ display:none; }',
    '.att-btn{ display:flex; align-items:center; justify-content:center;',
    '  width:34px; height:34px; border-radius:8px; border:1px solid var(--line);',
    '  background:var(--bg); color:var(--text-3); cursor:pointer;',
    '  transition:background .14s ease, color .14s ease; }',
    '.att-btn:hover{ background:var(--bg-2); color:var(--text); }',
    '.att-btn:focus-visible{ outline:none; box-shadow:0 0 0 3px rgba(0,102,204,0.3); }',
    '.att-btn svg{ width:17px; height:17px; }',
    '.atts{ display:none; flex-wrap:wrap; gap:6px; padding:11px 14px 0; }',
    '.att-chip{ display:flex; align-items:center; gap:4px; max-width:100%;',
    '  padding:4px 5px 4px 9px; border-radius:8px; background:var(--bg-2);',
    '  border:1px solid var(--line); font-size:12px; color:var(--text-2); }',
    '.att-chip.up{ opacity:0.65; }',
    '.att-name{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap;',
    '  max-width:148px; }',
    '.att-x{ display:flex; width:18px; height:18px; align-items:center;',
    '  justify-content:center; border:0; border-radius:5px; background:transparent;',
    '  color:var(--text-3); cursor:pointer; }',
    '.att-x:hover{ background:var(--line); color:var(--danger); }',
    '.att-x svg{ width:11px; height:11px; }',
    '.att-list{ display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; }',
    '.att-img{ width:74px; height:74px; object-fit:cover; border-radius:9px;',
    '  border:1px solid var(--line); cursor:pointer; display:block; }',
    '.att-img:hover{ border-color:var(--accent); }',
    '.att-file{ display:flex; align-items:center; gap:6px; max-width:200px;',
    '  padding:7px 11px; border-radius:9px; background:var(--bg-3);',
    '  border:1px solid var(--line); color:var(--text-2); text-decoration:none;',
    '  font-size:12.5px; }',
    '.att-file:hover{ border-color:var(--line-2); color:var(--text); }',
    '.att-file svg{ width:14px; height:14px; flex:none; }',
    '.att-file span:last-child{ overflow:hidden; text-overflow:ellipsis;',
    '  white-space:nowrap; }',
    /* Removing a single attachment: X at the top right of the preview. */
    '.att-item{ position:relative; display:inline-flex; }',
    '.att-del{ position:absolute; top:-6px; right:-6px; width:20px; height:20px;',
    '  border-radius:50%; border:1.5px solid #fff; background:rgba(15,23,42,0.72);',
    '  color:#fff; cursor:pointer; padding:0; display:flex; align-items:center;',
    '  justify-content:center; opacity:0; transition:opacity .12s var(--ease); }',
    '.att-item:hover .att-del, .att-del:focus-visible{ opacity:1; }',
    '.att-del svg{ width:12px; height:12px; }',
    '.att-confirm{ display:inline-flex; align-items:center; gap:6px;',
    '  padding:5px 8px; border-radius:9px; background:var(--bg-3);',
    '  border:1px solid var(--line); }',
    '.att-confirm-q{ font-size:12px; color:var(--text-2); }',
    '.att-confirm .mini{ height:26px; padding:0 10px; font-size:12px; }',
    '@media (prefers-reduced-motion: reduce){',
    '  *{ animation-duration:.01ms!important; transition-duration:.01ms!important; } }',

    /* --- Mobile (< 600px) --- */
    '@media (max-width:600px){',
    /* Sidebar -> bottom drawer (instead of a left panel) */
    '  .sb{ left:0; right:0; bottom:0; top:auto; width:auto; max-height:78vh;',
    '    border-right:none; border-top:1px solid var(--line);',
    '    border-radius:16px 16px 0 0;',
    '    box-shadow:0 -16px 48px -22px rgba(15,23,42,0.28);',
    '    transform:translateY(100%); }',
    '  .sb.open{ transform:translateY(0); }',
    '  .sb-list{ padding-bottom:22px; }',
    /* Popover -> bottom sheet (overrides the inline left/top via !important) */
    '  .pop{ position:fixed!important; left:0!important; right:0!important;',
    '    top:auto!important; bottom:0!important; width:auto!important;',
    '    max-height:88vh; overflow-y:auto;',
    '    border-radius:16px 16px 0 0; }',
    /* The sheet lives in .layer (z-index 2), under the FAB and the handle
       (z-index 8), which would cover its bottom buttons (Send, Cancel, Delete):
       while a popover is open they step aside (.has-pop, see mountPopover). */
    '  .layer.has-pop ~ .fab, .layer.has-pop ~ .handle{ visibility:hidden; pointer-events:none; }',
    '  .thread{ max-height:none; }',
    /* Pin: ~46px touch area without enlarging the dot (28px visual) */
    '  .pin::before{ content:""; position:absolute; inset:-9px; border-radius:50%; }',
    /* FAB/handle slightly more compact on phones */
    '  .fab, .handle{ height:44px; }',
    '}',
  ].join('\n');

  root.appendChild(el('style', { text: CSS }));

  var layer = el('div', { class: 'layer' });
  var catcher = el('div', { class: 'catcher' });
  var frame = el('div', { class: 'frame' });
  var hint = el('div', {
    class: 'hint',
    html: t('hint_html'),
  });
  var fab = el('button', { class: 'fab', type: 'button', 'aria-label': t('fab_aria_open') });
  var handle = el('button', { class: 'handle', type: 'button', 'aria-label': t('handle_aria') });
  var sidebar = el('div', { class: 'sb', role: 'complementary', 'aria-label': t('sidebar_aria') });
  root.appendChild(layer);
  root.appendChild(catcher);
  root.appendChild(frame);
  root.appendChild(hint);
  root.appendChild(fab);
  root.appendChild(handle);
  root.appendChild(sidebar);

  // --- FAB ----------------------------------------------------------------
  function renderFab() {
    fab.classList.toggle('active', state.mode);
    fab.innerHTML =
      '<span style="display:flex">' + (state.mode ? ICON.close : ICON.comment) + '</span>' +
      '<span>' + (state.mode ? t('fab_cancel') : t('fab_comment')) + '</span>';
  }

  fab.addEventListener('click', function () {
    if (state.popEl) closePopover();
    setMode(!state.mode);
  });

  function setMode(on) {
    state.mode = on;
    catcher.classList.toggle('on', on);
    frame.classList.toggle('on', on);
    hint.classList.toggle('on', on);
    fab.setAttribute('aria-label', on ? t('fab_aria_close') : t('fab_aria_open'));
    renderFab();
  }

  // --- Catcher: click to place a pin -------------------------------------
  catcher.addEventListener('click', function (e) {
    var px = e.clientX + window.scrollX;
    var py = e.clientY + window.scrollY;
    // Capture the robust anchor BEFORE leaving the mode: elementFromPoint
    // must see the site element under the click.
    var anchor = captureAnchor(e.clientX, e.clientY);
    // Server-side screenshot at the click point. Starts IMMEDIATELY in parallel (the
    // headless Chrome takes a few seconds): the composer opens without waiting
    // and the photo is attached on send if ready. Viewport coordinates for the dot.
    state.pendingShot = LIVE
      ? requestServerShot(e.clientX, e.clientY).catch(function (err) {
          console.warn('[pinna] screenshot failed:', err && err.message);
          return null;
        })
      : null;
    setMode(false);
    openComposer(px, py, anchor);
  });

  // --- Pin ----------------------------------------------------------------
  function topLevel() {
    return state.comments
      .filter(function (c) {
        // Only the pins of the current page and active viewport: each
        // viewport (desktop/tablet/mobile) has its own comments.
        return !c.parent_id
          && (!LIVE || (c.page_path || '') === PATH)
          && (c.viewport || 'desktop') === currentVp();
      })
      .sort(function (a, b) { return a.created_at - b.created_at; });
  }

  function renderPins(animateId) {
    layer.querySelectorAll('.pin').forEach(function (n) { n.remove(); });
    pinNodes = {};
    // The sidebar drives the page: with the Done tab (sidebar open) the
    // done pins are shown, otherwise the open ones.
    var showDone = state.sidebar && state.tab === 'done';
    topLevel().forEach(function (c, i) {
      var pos = commentPos(c);
      if (pos.x == null) return;
      if ((c.status === 'done') !== showDone) return;
      // Uncertain pin: anchor not resolved and author's width unknown (raw
      // fallback). We mark it so the user knows the position is approximate
      // and that the attached screenshot is the source of truth.
      var uncertain = pos.conf === 'raw';
      var pin = el('button', {
        class: 'pin' + (c.status === 'done' ? ' done' : '')
          + (state.openId === c.id ? ' sel' : '')
          + (uncertain ? ' approx' : ''),
        type: 'button',
        'aria-label': t('aria_comment', i + 1) + (uncertain ? ' (' + t('pos_approx') + ')' : ''),
        title: uncertain ? t('pos_approx') : '',
        html: c.status === 'done' ? ICON.check : String(i + 1),
      });
      pin.style.left = pos.x + 'px';
      pin.style.top = pos.y + 'px';
      if (animateId === c.id && !REDUCE) pin.classList.add('appear');
      pin.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openThread(c.id);
      });
      pinNodes[c.id] = pin;
      layer.appendChild(pin);
    });
  }

  // --- Sidebar: comment list --------------------------------------------
  function renderSidebar() {
    // Pins and numbering stay tied to the current page (topLevel). The
    // sidebar list instead covers ALL pages of the current viewport,
    // grouped by page, so a comment on another page is visible
    // and clickable (the jump navigates the iframe). See sidebarGroups + navigateTo.
    var byPage = sidebarGroups();
    var pageKeys = Object.keys(byPage).sort(function (a, b) {
      if (a === PATH) return -1;
      if (b === PATH) return 1;
      return a < b ? -1 : 1;
    });
    var allTops = pageKeys.reduce(function (acc, p) { return acc.concat(byPage[p]); }, []);
    var openN = allTops.filter(function (c) { return c.status === 'open'; }).length;
    var doneN = allTops.filter(function (c) { return c.status === 'done'; }).length;

    handle.classList.toggle('hidden', state.sidebar);
    handle.innerHTML =
      '<span style="display:flex">' + ICON.list + '</span>' +
      '<span>' + t('handle_comments') + '</span>' +
      (openN ? '<span class="count">' + openN + '</span>' : '');

    sidebar.classList.toggle('open', state.sidebar);
    sidebar.innerHTML = '';

    var head = el('div', { class: 'sb-head' }, [
      el('div', null, [
        el('div', { class: 'sb-logo', html: WORDMARK }),
        el('div', { class: 'sb-sub', text: t('sb_subtitle') }),
      ]),
      el('div', { class: 'spacer' }),
      el('button', {
        class: 'x', type: 'button', 'aria-label': t('sb_close'),
        onclick: function () { toggleSidebar(false); },
      }, el('span', { html: ICON.chevron })),
    ]);

    function tabBtn(key, label, n) {
      return el('button', {
        class: 'tab' + (state.tab === key ? ' on' : ''),
        type: 'button',
        'aria-pressed': state.tab === key ? 'true' : 'false',
        onclick: function () { state.tab = key; renderSidebar(); renderPins(); },
      }, [label, el('span', { class: 'n', text: String(n) })]);
    }
    var tabs = el('div', { class: 'sb-tabs' }, [
      tabBtn('open', t('tab_open'), openN),
      tabBtn('done', t('tab_done'), doneN),
    ]);

    // Text + author filter. The bar only appears if the list is long
    // (> 6 comments) so as not to add noise on small projects.
    var q = (state.search || '').trim().toLowerCase();
    function matchFilter(c) {
      var statusOk = state.tab === 'done' ? c.status === 'done' : c.status === 'open';
      if (!statusOk) return false;
      if (state.author !== 'all' && c.author !== state.author) return false;
      if (q && (c.body || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    }
    var searchBar = null;
    if (allTops.length > 6) {
      var sInput = el('input', {
        class: 'sb-search-input', type: 'text', value: state.search,
        placeholder: t('search_ph'), 'aria-label': t('search_aria'),
        oninput: function () {
          state.search = sInput.value;
          renderSidebar();
          // the rebuild recreates the input: restore focus + cursor at the end.
          var ni = sidebar.querySelector('.sb-search-input');
          if (ni) { ni.focus(); var L = ni.value.length; try { ni.setSelectionRange(L, L); } catch (e) {} }
        },
      });
      var fBtn = function (key, label) {
        return el('button', {
          class: 'sb-fbtn' + (state.author === key ? ' on' : ''),
          type: 'button', 'aria-pressed': state.author === key ? 'true' : 'false',
          onclick: function () { state.author = key; renderSidebar(); },
        }, label);
      };
      var fbtns = [fBtn('all', t('filter_all')), fBtn('admin', t('filter_admin')), fBtn('client', t('filter_client'))];
      // 'collab' filter only if there are comments from a collaborator
      // (no extra button on projects without a collab).
      if (state.comments.some(function (c) { return c.author === 'collab'; })) {
        fbtns.push(fBtn('collab', t('filter_collab')));
      }
      searchBar = el('div', { class: 'sb-search' }, [
        sInput,
        el('div', { class: 'sb-filter' }, fbtns),
      ]);
    }

    var list = el('div', { class: 'sb-list' });
    var anyRow = false;
    pageKeys.forEach(function (p) {
      var groupRows = byPage[p].filter(matchFilter);
      if (!groupRows.length) return;
      anyRow = true;
      var isCurrent = !LIVE || p === PATH;
      // Page heading only for pages other than the open one:
      // a click navigates the iframe to that page (and opens the first comment).
      if (!isCurrent) {
        list.appendChild(el('button', {
          class: 'sb-page', type: 'button',
          'aria-label': t('aria_goto_page', p || '/'),
          onclick: function () { navigateTo(p, groupRows[0].id); },
        }, [
          el('span', { class: 'sb-page-path', text: p || '/' }),
          el('span', { class: 'sb-page-go', text: t('page_open') }),
        ]));
      }
      groupRows.forEach(function (c) {
        var n = byPage[p].findIndex(function (t) { return t.id === c.id; }) + 1;
        var nReplies = state.comments.filter(function (x) {
          return x.parent_id === c.id;
        }).length;
        var done = c.status === 'done';
        list.appendChild(el('button', {
          class: 'sb-item', type: 'button',
          'aria-label': isCurrent ? t('aria_goto_comment', n) : t('aria_goto_comment_page', p || '/', n),
          onclick: function () { if (isCurrent) jumpTo(c.id); else navigateTo(p, c.id); },
        }, [
          el('span', {
            class: 'sb-num' + (done ? ' done' : ''),
            html: done ? ICON.check : String(n),
          }),
          el('div', null, [
            el('div', { class: 'sb-body', text: c.body }),
            el('div', { class: 'sb-meta' }, [
              el('span', {
                class: 'who ' + c.author,
                text: c.author === 'admin' ? t('author_admin') : c.author === 'collab' ? t('author_collab') : t('author_client'),
              }),
              el('span', { text: relTime(c.created_at) }),
              nReplies
                ? el('span', { text: '· ' + t('replies', nReplies) })
                : null,
            ]),
          ]),
        ]));
      });
    });

    if (!anyRow) {
      var filtering = q || state.author !== 'all';
      list.appendChild(el('div', { class: 'sb-empty' }, filtering ? [
        el('b', { text: t('empty_no_results') }),
        t('empty_no_results_sub'),
      ] : [
        el('b', { text: state.tab === 'done' ? t('empty_done') : t('empty_open') }),
        state.tab === 'done' ? t('empty_done_sub') : t('empty_open_sub'),
      ]));
    }

    sidebar.appendChild(head);
    sidebar.appendChild(tabs);
    if (searchBar) sidebar.appendChild(searchBar);
    sidebar.appendChild(list);
  }

  // Top-level comments of the current viewport grouped by page (page_path).
  // In demo (!LIVE) everything falls on the current page, a single group.
  function sidebarGroups() {
    var vp = currentVp();
    var by = {};
    state.comments.forEach(function (c) {
      if (c.parent_id) return;
      if ((c.viewport || 'desktop') !== vp) return;
      var p = !LIVE ? PATH : (c.page_path || '');
      (by[p] = by[p] || []).push(c);
    });
    Object.keys(by).forEach(function (p) {
      by[p].sort(function (a, b) { return a.created_at - b.created_at; });
    });
    return by;
  }

  function toggleSidebar(open) {
    state.sidebar = open;
    // The page follows the sidebar: closed = open pins, open = follows the tab.
    renderSidebar();
    renderPins();
  }

  // Scrolls to a position and calls cb ONLY when the scroll has settled
  // (or after a safety cap). Avoids the race in which the popover is
  // positioned against the old scroll while the smooth scroll is in progress.
  function scrollAndThen(target, cb) {
    if (REDUCE || Math.abs(window.scrollY - target) < 2) {
      window.scrollTo(0, target);
      cb();
      return;
    }
    window.scrollTo({ top: target, left: 0, behavior: 'smooth' });
    var done = false;
    var t0 = Date.now();
    function finish() { if (done) return; done = true; cb(); }
    (function poll() {
      if (done) return;
      if (Math.abs(window.scrollY - target) < 2 || Date.now() - t0 > 900) { finish(); return; }
      requestAnimationFrame(poll);
    })();
  }

  // Flashes the target pin: a visual anchor after the jump.
  function pulsePin(id) {
    if (REDUCE) return;
    var pin = pinNodes[id];
    if (!pin) return;
    pin.classList.remove('flash');
    void pin.offsetWidth; // forces the animation to restart
    pin.classList.add('flash');
  }

  // Comment on another page of the site: asks the parent (Pinna app) to
  // navigate the iframe to that page; the widget restarts and opens the thread
  // (openId in the init). In demo it stays on the current page.
  function navigateTo(path, id) {
    if (!LIVE) { jumpTo(id); return; }
    try {
      window.parent.postMessage({ type: 'pinna-navigate', path: path, openId: id, pt: PROXY_PT, ch: CHANNEL }, CFG.api);
    } catch (_) {
      jumpTo(id);
    }
  }

  function jumpTo(id) {
    var c = state.comments.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    // On another page of the site: delegates the iframe navigation to the parent.
    if (LIVE && (c.page_path || '') && (c.page_path || '') !== PATH) {
      navigateTo(c.page_path, id);
      return;
    }
    var pos = commentPos(c);
    if (pos.y != null) {
      var target = Math.max(0, pos.y - window.innerHeight / 2);
      scrollAndThen(target, function () { openThread(id); pulsePin(id); });
    } else {
      openThread(id);
    }
  }

  handle.addEventListener('click', function () { toggleSidebar(true); });

  // --- Popover: positioning ---------------------------------------------
  function placePopover(pop, px, py) {
    var W = 320;
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    var vx = px - window.scrollX;
    var vy = py - window.scrollY;
    var right = vx + 24 + W <= vw - 8;
    var left = right ? px + 22 : px - 22 - W;
    if (!right && left < window.scrollX + 8) left = window.scrollX + 8;
    // Do not let the popover end up under the open sidebar.
    if (state.sidebar && left - window.scrollX < 324) left = window.scrollX + 324;
    pop.style.left = left + 'px';
    var h = pop.offsetHeight || 240;
    var topV = Math.min(Math.max(vy - 22, 12), Math.max(12, vh - h - 12));
    pop.style.top = (topV + window.scrollY) + 'px';
    pop.style.transformOrigin = (right ? 'left' : 'right') + ' ' +
      (vy - topV < 40 ? 'top' : 'center');
  }

  // Popover focus management (a11y dialog): trap Tab inside the popover
  // + restore focus on close.
  var popLastFocus = null;
  function popFocusables(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; },
    );
  }
  function trapTab(e) {
    if (e.key !== 'Tab' || !state.popEl) return;
    var f = popFocusables(state.popEl);
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    var active = root.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  function mountPopover(pop, px, py) {
    if (state.popEl) state.popEl.remove();
    state.popEl = pop;
    layer.classList.add('has-pop');
    layer.appendChild(pop);
    placePopover(pop, px, py);
    pop.setAttribute('aria-modal', 'true');
    popLastFocus = root.activeElement;
    root.addEventListener('keydown', trapTab, true);
    requestAnimationFrame(function () { pop.classList.add('in'); });
    setTimeout(function () {
      window.addEventListener('pointerdown', onDocDown, true);
    }, 0);
    var ta = pop.querySelector('textarea');
    if (ta) ta.focus();
  }

  function closePopover() {
    window.removeEventListener('pointerdown', onDocDown, true);
    root.removeEventListener('keydown', trapTab, true);
    var lf = popLastFocus;
    popLastFocus = null;
    if (state.popEl) state.popEl.remove();
    state.popEl = null;
    layer.classList.remove('has-pop');
    state.openId = null;
    // No orphan pins: closing the composer (also with Esc or an outside click)
    // removes the dot of the comment that was never saved.
    if (state.draftEl) {
      state.draftEl.remove();
      state.draftEl = null;
    }
    renderPins();
    // Restore focus to where we were (e.g. the sidebar entry), if it is still there.
    if (lf && lf.isConnected && typeof lf.focus === 'function') lf.focus();
  }

  function onDocDown(e) {
    if (!state.popEl) return;
    if (e.composedPath().indexOf(state.popEl) === -1) closePopover();
  }

  // Shows an inline error in the open popover (e.g. comment send failed):
  // the user sees that something went wrong instead of silence.
  function popoverError(msg) {
    if (!state.popEl) return;
    var foot = state.popEl.querySelector('.foot');
    if (!foot) return;
    var e = foot.querySelector('.pop-err');
    if (!e) {
      e = el('div', { class: 'pop-err', role: 'alert' });
      foot.insertBefore(e, foot.firstChild);
    }
    e.textContent = msg;
  }

  // --- Composer (new pin) -----------------------------------------------
  function openComposer(px, py, anchor) {
    closePopover();
    var draft = el('div', { class: 'draft' });
    draft.style.left = px + 'px';
    draft.style.top = py + 'px';
    layer.appendChild(draft);
    state.draftEl = draft;

    var ta = el('textarea', {
      id: 'pinna-new',
      placeholder: t('composer_ph'),
      // Same limit as the server (worker/schemas.ts COMMENT_BODY_MAX).
      maxlength: '5000',
    });
    var att = LIVE ? attachUI() : null;
    var pop = el('div', { class: 'pop', role: 'dialog', 'aria-label': t('composer_title') }, [
      el('div', { class: 'pop-head' }, [
        el('span', { class: 'pop-title', text: t('composer_title') }),
        el('button', {
          class: 'x', type: 'button', 'aria-label': t('fab_cancel'),
          onclick: function () { draft.remove(); closePopover(); },
        }, el('span', { html: ICON.close })),
      ]),
      el('div', { class: 'foot' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'pinna-new', text: t('label_your_comment') }),
          ta,
        ]),
        att ? att.bar : null,
        att ? att.input : null,
        el('div', { class: 'row' }, [
          emojiPicker(ta),
          att ? att.button : null,
          el('button', {
            class: 'btn btn-ghost', type: 'button', text: t('fab_cancel'),
            onclick: function () { draft.remove(); closePopover(); },
          }),
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: t('btn_send'),
            onclick: function () {
              var body = ta.value.trim();
              if (!body) { ta.focus(); return; }
              var btn = this;
              btn.disabled = true; // prevents double submit while waiting
              // Attach the server-side screenshot (if ready) before saving:
              // /shot has already created the R2 attachment and returned its metadata,
              // so here we only add its id. If it is missing or failed, the comment is sent anyway.
              Promise.resolve(state.pendingShot).then(function (att2) {
                return att2 && att2.id ? [att2.id] : [];
              }).then(function (shotIds) {
                var ids = (att ? att.ids() : []).concat(shotIds);
                return store.add({
                  page_x: px, page_y: py, body: body, author: ME,
                  anchor_selector: anchor ? anchor.selector : null,
                  anchor_x: anchor ? anchor.x : null,
                  anchor_y: anchor ? anchor.y : null,
                  attachment_ids: ids,
                });
              }).then(function (saved) {
                state.pendingShot = null;
                draft.remove();
                refresh(saved.id).then(function () { openThread(saved.id); });
              }).catch(function (err) {
                btn.disabled = false;
                popoverError(t('err_send'));
                console.warn('[pinna] send failed:', err && err.message);
              });
            },
          }),
        ]),
      ]),
    ]);
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        pop.querySelector('.btn-primary').click();
      }
    });
    mountPopover(pop, px, py);
  }

  // --- Thread (existing pin) --------------------------------------------
  function openThread(id) {
    closePopover();
    var pin = state.comments.filter(function (c) { return c.id === id; })[0];
    if (!pin) return;
    state.openId = id;
    // Redraw the pins: the selected pin immediately gets the .sel ring and ends up
    // in pinNodes, so pulsePin (on the jump from the sidebar) finds it.
    renderPins();
    var num = topLevel().findIndex(function (c) { return c.id === id; }) + 1;
    var replies = state.comments
      .filter(function (c) { return c.parent_id === id; })
      .sort(function (a, b) { return a.created_at - b.created_at; });
    var done = pin.status === 'done';
    // Deleting a pin deletes its whole thread: with a reply or a file by
    // someone else the server applies the admin rule even to the pin's author,
    // so the widget-token may delete directly only an all-own thread (own pin,
    // own replies, own files: each file says `mine`).
    var ownThread = !!pin.mine && [pin].concat(replies).every(function (c) {
      return (c === pin || c.mine) && (c.attachments || []).every(function (a) { return a.mine; });
    });

    // A message (comment or reply). The author can edit it: the
    // text becomes an inline textarea, saved via PATCH body. Only one
    // editor open at a time: opening one closes the previous one.
    var openEditor = null;
    function msg(c) {
      var wrap = el('div', { class: 'msg' });
      function viewMode() {
        if (openEditor === viewMode) openEditor = null;
        wrap.innerHTML = '';
        wrap.appendChild(el('div', { class: 'msg-top' }, [
          el('span', {
            class: 'who ' + c.author,
            text: c.author === 'admin' ? t('author_admin') : c.author === 'collab' ? t('author_collab') : t('author_client'),
          }),
          el('span', { class: 'when', text: relTime(c.created_at) }),
          c.mine
            ? el('button', {
                class: 'msg-edit', type: 'button', text: t('msg_edit'), onclick: editMode,
              })
            : null,
        ]));
        wrap.appendChild(el('div', { class: 'msg-body', text: c.body }));
        if (c.attachments && c.attachments.length) {
          // The comment's author (or an admin) can remove a single
          // attachment without deleting the whole comment.
          var canDelAtt = c.mine || IS_ADMIN;
          var list = el('div', { class: 'att-list' });
          c.attachments.forEach(function (a) {
            // Thumbnail: fetch with the Authorization header. New tab and link
            // (the browser opens the URL on its own, no header): a.url, a
            // short-lived READ-ONLY address for this file, issued by the API.
            var url = apiUrl('/api/attachments/' + encodeURIComponent(a.id));
            var openUrl = a.url ? CFG.api + a.url : url;
            var media;
            if (/^image\//.test(a.content_type || '')) {
              var img = el('img', {
                class: 'att-img', alt: a.filename, loading: 'lazy', title: a.filename,
              });
              // Thumbnail via fetch -> dataURL: the attachment is served from the Pinna
              // origin and the client site's img-src CSP might not include it
              // (<img src=URL> would be blocked). connect-src allows Pinna and
              // img-src allows data:, so the thumbnail shows in the widget.
              fetch(url, { headers: authHeaders() }).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
                if (!b) return;
                var fr = new FileReader();
                fr.onload = function () { img.src = fr.result; };
                fr.readAsDataURL(b);
              }).catch(function () { /* thumbnail not available */ });
              // Click: opens the image full size in a new tab (Pinna context,
              // no site CSP) -> the direct URL works there.
              img.addEventListener('click', function () { window.open(openUrl, '_blank'); });
              media = img;
            } else {
              media = el('a', {
                class: 'att-file', href: openUrl, target: '_blank', rel: 'noopener',
              }, [
                el('span', { html: ICON.clip }),
                el('span', { text: a.filename }),
              ]);
            }
            if (!canDelAtt) { list.appendChild(media); return; }
            // Wrapper with X + inline confirmation (delete is irreversible: R2
            // versioning OFF). No native confirm(): it would block events.
            var item = el('div', { class: 'att-item' }, [media]);
            var xBtn = el('button', {
              class: 'att-del', type: 'button', 'aria-label': t('attach_remove'),
              title: t('attach_remove'), html: ICON.close,
            });
            xBtn.addEventListener('click', function () {
              var confirmRow = el('div', { class: 'att-confirm' }, [
                el('span', { class: 'att-confirm-q', text: t('att_del_confirm') }),
                el('button', {
                  class: 'mini mini-go', type: 'button', text: t('att_del_yes'),
                  onclick: function () {
                    this.disabled = true;
                    // The server lets the widget-token remove only files the
                    // caller uploaded (a.mine), not every file of their own
                    // comment. Someone else's file, for an admin: the app
                    // removes it. A refused direct delete: an admin goes on
                    // through the app, a client is told why.
                    var removed = function () { refresh().then(function () { openThread(id); }); };
                    var failed = function (err) {
                      popoverError(t('err_att_del'));
                      console.warn('[pinna] removing attachment failed:', err && err.message);
                    };
                    if (!a.mine && IS_ADMIN) {
                      adminViaApp('delete-attachment', a.id).then(removed).catch(failed);
                      return;
                    }
                    deleteAttachmentReq(a.id).then(removed).catch(function (err) {
                      if (err && err.status === 403) {
                        if (IS_ADMIN) return adminViaApp('delete-attachment', a.id).then(removed).catch(failed);
                        popoverError(t('err_att_admin_only'));
                        return;
                      }
                      failed(err);
                    });
                  },
                }),
                el('button', {
                  class: 'mini', type: 'button', text: t('att_del_no'),
                  onclick: function () { confirmRow.replaceWith(xBtn); },
                }),
              ]);
              xBtn.replaceWith(confirmRow);
            });
            item.appendChild(xBtn);
            list.appendChild(item);
          });
          wrap.appendChild(list);
        }
      }
      function editMode() {
        if (openEditor) openEditor();
        openEditor = viewMode;
        wrap.innerHTML = '';
        var eta = el('textarea', { class: 'edit-ta', maxlength: '5000' });
        eta.value = c.body;
        wrap.appendChild(eta);
        wrap.appendChild(el('div', { class: 'edit-row' }, [
          el('button', { class: 'mini', type: 'button', text: t('fab_cancel'), onclick: viewMode }),
          el('button', {
            class: 'mini mini-go', type: 'button', text: t('btn_save'),
            onclick: function () {
              var v = eta.value.trim();
              if (!v) { eta.focus(); return; }
              var btn = this;
              btn.disabled = true;
              store.update(c.id, { body: v }).then(function () {
                refresh().then(function () { openThread(id); });
              }).catch(function (err) {
                btn.disabled = false;
                popoverError(t('err_save'));
                console.warn('[pinna] edit failed:', err && err.message);
              });
            },
          }),
        ]));
        eta.focus();
      }
      viewMode();
      return wrap;
    }

    var ta = el('textarea', { id: 'pinna-reply', placeholder: t('reply_ph'), maxlength: '5000' });
    var att = LIVE ? attachUI() : null;
    var thread = el('div', { class: 'thread' }, [msg(pin)].concat(replies.map(msg)));

    var pop = el('div', { class: 'pop', role: 'dialog', 'aria-label': t('aria_comment', num) }, [
      el('div', { class: 'pop-head' }, [
        el('span', { class: 'pop-num', text: '#' + num }),
        el('span', {
          class: 'badge ' + (done ? 'done' : 'open'),
          text: done ? t('badge_done') : t('badge_open'),
        }),
        el('button', {
          class: 'x', type: 'button', 'aria-label': t('close_aria'), onclick: closePopover,
        }, el('span', { html: ICON.close })),
      ]),
      thread,
      el('div', { class: 'foot' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'pinna-reply', text: t('label_reply') }),
          ta,
        ]),
        att ? att.bar : null,
        att ? att.input : null,
        el('div', { class: 'row' }, [
          emojiPicker(ta),
          att ? att.button : null,
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: t('btn_reply'),
            onclick: function () {
              var body = ta.value.trim();
              if (!body) { ta.focus(); return; }
              var btn = this;
              btn.disabled = true;
              store.add({
                parent_id: id, body: body, author: ME,
                attachment_ids: att ? att.ids() : [],
              }).then(function () { refresh().then(function () { openThread(id); }); })
                .catch(function (err) {
                  btn.disabled = false;
                  popoverError(t('err_reply'));
                  console.warn('[pinna] reply failed:', err && err.message);
                });
            },
          }),
        ]),
        // "Mark as done" is a developer action: admins only.
        IS_ADMIN
          ? el('button', {
              class: 'btn btn-block ' + (done ? 'btn-ghost' : 'btn-done'), type: 'button',
              html: (done ? '' : ICON.check) + (done ? t('btn_reopen') : t('btn_mark_done')),
              onclick: function () {
                var btn = this;
                btn.disabled = true;
                store.update(id, { status: done ? 'open' : 'done' })
                  .then(function () { refresh().then(function () { openThread(id); }); })
                  .catch(function (err) {
                    btn.disabled = false;
                    popoverError(t('err_status'));
                    console.warn('[pinna] status change failed:', err && err.message);
                  });
              },
            })
          : null,
        // Delete: admins always (through the app's confirmation unless the
        // thread is all theirs), the author only an own thread (ownThread).
        IS_ADMIN || ownThread
          ? el('div', { class: 'row' }, [
              el('button', {
                class: 'del', type: 'button', text: t('btn_delete'),
                onclick: function () {
                  var btn = this;
                  btn.disabled = true;
                  var deleted = function () { closePopover(); refresh(); };
                  var failed = function (err) {
                    btn.disabled = false;
                    popoverError(t('err_delete'));
                    console.warn('[pinna] delete failed:', err && err.message);
                  };
                  store.remove(id, ownThread).then(deleted).catch(function (err) {
                    // Refused (403) although the thread looked all ours: the list
                    // is not refreshed while a popover is open, and someone may
                    // have replied or added a file since. An admin goes on
                    // through the app's confirmation; a client is told why.
                    if (ownThread && err && err.status === 403) {
                      if (IS_ADMIN) return store.remove(id, false).then(deleted).catch(failed);
                      btn.disabled = false;
                      popoverError(t('err_delete_admin_only'));
                      return;
                    }
                    failed(err);
                  });
                },
              }),
            ])
          : null,
      ]),
    ]);
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        pop.querySelector('.btn-primary').click();
      }
    });
    var pinPos = commentPos(pin);
    mountPopover(pop, pinPos.x, pinPos.y);
  }

  // --- Refresh ------------------------------------------------------------
  function refresh(animateId) {
    return store.list().then(function (list) {
      state.comments = list;
      renderPins(animateId);
      renderFab();
      renderSidebar();
    }).catch(function (err) {
      console.warn('[pinna] loading comments failed:', err && err.message);
    });
  }

  // --- Global events ------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.popEl) closePopover();
    else if (state.mode) setMode(false);
    else if (state.sidebar) toggleSidebar(false);
  });

  // Resize: the pins (and the open popover) are repositioned. With anchoring the
  // pins follow their element even when resizing WITHIN the same viewport
  // band (redrawing only on a band change would leave the pins at their old
  // coordinates after a "normal" resize). If the band (desktop/tablet/mobile)
  // changes, the comment set changes too -> redraw the sidebar as well.
  // Debounced so it does not recompute at every px.
  var vpLast = currentVp();
  var resizeT = null;
  window.addEventListener('resize', function () {
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      resizeT = null;
      var vp = currentVp();
      if (vp !== vpLast) {
        vpLast = vp;
        if (state.popEl) closePopover();
        renderPins();
        renderSidebar();
        return;
      }
      // Same band: reposition the pins (anchored ones follow the element) and,
      // if a thread is open, reposition the popover on the pin.
      renderPins();
      if (state.popEl && state.openId) {
        var oc = state.comments.filter(function (c) { return c.id === state.openId; })[0];
        if (oc) {
          var p = commentPos(oc);
          if (p.x != null) placePopover(state.popEl, p.x, p.y);
        }
      }
    }, 120);
  });

  // --- Startup -----------------------------------------------------------
  renderFab();
  refresh().then(function () {
    // Cross-page deep link: after the first load, open the requested comment.
    if (pendingOpenId) {
      var oid = pendingOpenId;
      pendingOpenId = null;
      setTimeout(function () { jumpTo(oid); }, 180);
    }
  });

  // Comment polling (LIVE only): you and the client see each other's updates
  // without reloading the iframe. Paused when a popover is open (do not
  // disturb reading/writing), while placing a pin, or when the tab is
  // hidden. GET /comments is not rate limited; 20s = 3 requests/min.
  if (LIVE) {
    setInterval(function () {
      if (document.hidden || state.popEl || state.mode) return;
      refresh();
    }, 20000);
  }
})();
