# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the Security tab of this repository and choose "Report a vulnerability". Do not open a public issue for a security problem.

There is no guaranteed response time, but every report is read and answered. Supported version: the latest commit on `main`.

## About this document

This is the security model as the code implements it. Where this document and the code disagree, the code is right and the document has a bug: please report it. The code was reviewed adversarially several times before publication. What those reviews left open is listed under [Known limits](#known-limits), with the consequence of each item.

## Roles

| Role | Where it comes from | What it can do |
| --- | --- | --- |
| `admin` | An address listed in `ADMIN_EMAILS`, recomputed on every request | Every project: create projects, invite clients and collaborators, remove members, mark comments done or reopen them, delete any comment or file, sign a user out everywhere |
| `collab` | Membership role `collab` on a project, given by a global admin | On that project only: invite and remove clients, list members, mark comments done or reopen them, delete any comment or file |
| `client` | Membership role `client` on a project | On that project: read comments and files, write comments and replies, upload files, request screenshots, edit their own comments, delete their own replies, their own pins whose whole thread is theirs, and their own files |

- Admin rights on a project come from being a global admin or from a `collab` membership on that project. A `collab` value in the user's global role grants nothing by itself.
- Deleting a pin deletes its whole thread: the replies and every file attached to them. If the thread holds a reply by someone else, or a file uploaded by someone else or with no recorded uploader, the admin rule applies to the pin's author too: the widget token is refused (403) and, from the app, only a project admin can delete it. A reply can still be deleted on its own by its author. The widget offers its author a direct delete only when the pin, every reply and every file in the thread are theirs. If that delete is still refused (someone replied or added a file while the thread was open), a project admin's widget goes on through the confirmation bar, and a client's widget says that only a project admin can delete the thread. A single file works the same way: the widget removes directly only a file the reader uploaded; any other file goes through the confirmation bar for a project admin, and a client reads that only a project admin can remove it.
- Every answer that returns comments uses one fixed set of fields: the list (`GET /api/projects/:slug/comments`), a new comment and an edit. The fields are id, parent, page path, selector, anchor offsets and page coordinates, viewport, text, status, creation and resolution times, `author_role`, `mine` (whether the requester wrote it) and the attachments (id, file name, type, short-lived URL, and `mine`: whether the requester uploaded it). A new comment also gets `attachments_linked` and `attachments_requested`; an edit of a comment that no longer exists gets 404. `author_role` is the author's role on this project: `admin` for a global admin, `collab` for a collaborator membership, `client` otherwise, former members included. Author ids, global roles, uploader ids, file sizes and storage keys are not sent.
- Only global admins add or remove collaborators. A collaborator can remove only clients. A global admin cannot be removed from a project.
- An invitation can raise a membership from `client` to `collab`, never lower it.
- The answer to an invitation is `{ ok: true }` and nothing else: it does not tell the inviter whether the address was already registered or belongs to an admin.
- A signed-in user who is not a member of a project gets 403 on its comment, file, screenshot and widget-token routes, and 401 on the project's admin routes (invite, members).
- `ADMIN_EMAILS` decides the admin role on every request. A listed address is promoted; an admin no longer listed is demoted to `client` (memberships stay) and all their sessions and tokens are revoked. A list that is absent, empty, without any `name@domain` entry, or without any of the admins already in the database is treated as missing configuration: roles stay as stored, nobody is promoted or demoted, `/entra` does not sign in, and the Worker logs an error. On a new instance (no admin in the database) a valid list takes effect at once.

## Tokens and credentials

Every token is a JSON payload signed with HMAC-SHA256. Each token type has its own key, derived from `SESSION_SECRET` as `HMAC(SESSION_SECRET, "pinna-token-v2:<type>")`, and carries a `typ` field that is checked on verification: a token of one type is never accepted as another. Signatures are compared in constant time. Changing `SESSION_SECRET` invalidates every session and token at once.

| Credential | Where it lives | What it allows | Lifetime and revocation |
| --- | --- | --- | --- |
| Session cookie `__Host-pinna_session` | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` | Everything the user's role allows in the app. Routes that change state also need the CSRF token | 30 days. Refused after a sign-out (all devices), a sign-out by an admin or a demotion: a per-user cutoff in `session_revocations` is compared with the token's issue time |
| CSRF cookie `__Host-pinna_csrf` | Readable by the app's JavaScript, `Secure`, `SameSite=Strict` | Double submit: the app copies it into `X-CSRF-Token` and the server compares the two in constant time | 30 days, a new value at every sign-in, cleared at sign-out |
| Widget token | In the reviewed page, held in the widget's memory; sent only in `Authorization: Bearer`. No token is written to storage: in the staging site's `sessionStorage` the widget keeps only `__pinna_ctx` (project slug, Pinna's API origin, role) and `__pinna_frame` | On one project: read comments and files, create comments and replies, edit the user's own comments, delete the user's own replies and the user's own pins whose whole thread is theirs, upload files, request screenshots, delete the user's own files | 1 hour, renewed by the app through `postMessage`. Refused after the user's cutoff and as soon as the membership is removed. The query parameter `?wt=` is not read |
| Attachment URL token (`?at=`) | In the `url` of each file in the comment list, for `<img>`, links and new tabs | Only `GET /api/attachments/:id`, only for files of that project | 10 minutes. Checked against the cutoff, the admin list and the membership at every use. One token per project and user, signed once per list |
| Proxy token (`?pinna_pt=`) | In the URL of the proxied page inside the frame | Only `/_proxy`, only on the project's staging origin. Bound to the user, the project and that origin | 1 hour. Issued only when `PINNA_PROXY_ENABLED=1`. It has no issue time, so sign-out and session revocation do not cancel it. Refused once the membership is removed, the user is demoted, or the project's staging origin no longer matches |
| Admin key (`ADMIN_KEY`) | A secret. Sent in the POST body of `/entra` (from the `#k=` bookmark page) or in the `X-Admin-Key` header of `/api/summary` | `/entra`: a session as the first listed admin. `/api/summary`: a read-only list of all projects with counts | Until rotated. Compared as SHA-256 digests in constant time. Attempts are written to `admin_audit` |
| Sign-in link | In the sign-in email | One sign-in | 90 minutes, single use, stored as a SHA-256 hash |
| Six-digit code | In the same email | One sign-in, typed into the open page | 90 minutes, 5 attempts, stored in plain text in D1 |

Actions that change other people's work are not possible with the widget token: marking a comment done, reopening it, deleting someone else's comment or file, deleting a pin whose thread holds someone else's work. The widget sends the request to the app with `postMessage`. The app accepts messages only from its own iframe (in direct mode the staging origin; in proxy mode origin `null` plus a proxy token it issued and a per-document channel secret) and only when the user is an admin of the project. It takes the text to confirm from the API rather than from the message, and accepts one request at a time: a second one is refused while the first waits for the click or is still being prepared, even when the two messages arrive in the same tick. For a pin with replies the bar asks to delete the comment and its N replies. The app calls the API with the session cookie and the CSRF token only after the user clicks the confirmation bar in the app's own page. A script on the site can send the message; it cannot click inside the app.

The widget never takes its API address from the URL (`?pinna_api=` is not read). Inside Pinna's frame it uses the origin `pinna.js` was loaded from, and accepts the token only from a message of that origin. Without that check, any site could frame the staging page, complete the handshake and receive comments and page snapshots.

## Sign-in

### Requesting a link and a code

`POST /api/auth/request`:

- Only `Content-Type: application/json` is accepted (415 otherwise). A form or a plain cross-site `fetch` cannot send that type without a CORS preflight, and these routes grant none.
- Without `RESEND_API_KEY`, outside local dev mode, every address gets 503 before anything is looked up.
- The `ANON_RL` shield allows 10 requests per minute per IP (IPv6 grouped by /48), before the body is read. If the binding errors, the route answers 503.
- The body needs a `Content-Length` (411 without) of at most 16 KB (413 over).
- An address listed in `ADMIN_EMAILS` is created or promoted to admin before the lookup, unless the list is missing configuration.
- An unknown address gets `{ ok: true }` after a dummy query and a random wait of 100 to 300 ms. Nothing is written.
- A known address whose latest link still has a usable code (not used, not expired, fewer than 5 attempts) gets `{ ok: true }` and no new email; nothing is counted.
- Otherwise, for known addresses only, counters on D1 decide. All of them fail closed (503 if D1 does not answer): 3 emails per hour per address and IP, 10 per hour per address, 24 per address in a sliding 24 hours, and the instance-wide cap below. Over any of them the answer is still `{ ok: true }` and no email leaves, so a 429 cannot reveal that the address exists. Reaching the per-address daily cap or the instance-wide cap raises an alert, at most one per hour.
- Instance-wide cap: `PINNA_EMAIL_DAILY_CAP` (default 80) emails in a sliding 24 hours, sign-in and notifications together. A quarter of it is kept for admins: client sign-in and notifications stop at three quarters, admin sign-in can use the whole cap. Alert emails are not counted.
- If Resend refuses the email, after one retry, the new link is closed, every counter is given back, and the answer is a visible 502.
- Dev mode returns the link and the code in the answer only when `PINNA_DEV_MODE=1`, the request's host is `localhost`, `127.0.0.1` or `[::1]`, and `RESEND_API_KEY` is absent.

### The link

- Both link routes, `GET` and `POST /api/auth/verify`, first pass the `ANON_RL` shield, like the other sign-in routes: 10 requests per minute per IP (/48), one bucket each, before the link is looked up. Past it, the link page answers 429 with a small HTML page (wait a minute and reload, the link is still valid) and a `Retry-After` header; the POST answers 429 in JSON. They fail open, because they send nothing.
- `GET /api/auth/verify?token=` changes nothing. It reads the link without using it up and returns a page with a button that names the account the link signs into, masked (first character, `***`, then the domain: `a***@example.com`). Anyone can send someone else a sign-in link to their own account, and the recipient would then comment as them; the masked address makes that visible before the click. An unknown, used or expired link gets no page: it redirects to the sign-in page (`/login?err=expired`). The page has `Cache-Control: no-store`, `Referrer-Policy: same-origin` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. Mail scanners that open links do not use them up.
- `POST /api/auth/verify` uses the link, and only from Pinna's own origin: the `Origin` header must match; `Origin: null` passes only with `Sec-Fetch-Site: same-origin`; a request with neither header passes (older browsers). This blocks login CSRF, where a third-party page would sign the visitor into the attacker's account. The form body is capped at 16 KB.
- The token has 256 random bits and is stored as a SHA-256 hash. It is valid for 90 minutes and used up atomically (`UPDATE ... RETURNING`): of two parallel uses, one wins.
- After any successful sign-in, the other open links and codes of that address are closed.
- The admin role is recomputed from `ADMIN_EMAILS` before the session is signed.

### The code

`POST /api/auth/verify-code`:

- JSON only (415 otherwise), exactly 6 digits. `ANON_RL` allows 10 requests per minute per IP (/48) and 10 per minute per address; these fail open, because the route sends nothing.
- The code is drawn uniformly (rejection sampling) and stored in plain text next to the link hash: the defence is the attempt limit and the 90-minute window, not secrecy at rest.
- Only the latest open code of the address is compared. Each attempt books its slot with one conditional `UPDATE` before the comparison, so parallel guesses cannot exceed 5 per code. At 5 the code is switched off; the link in the same email still works.
- After 20 wrong codes for one address in a sliding 24 hours, code sign-in is refused for that address, even with the right code. That makes at most 20 guesses per address per 24 hours. An unknown address, or one without an open code, writes nothing, and every wrong or expired code gets the same 401.
- A right code sets the same cookies as the link.

### The admin key

- `GET /entra` returns a page with a per-request nonce in its CSP. It reads `#k=` from the fragment, removes it from the address bar with `history.replaceState` and posts it to `/entra`. Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; script-src 'nonce-...'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`.
- A key in the query string (`/entra?k=`) gets a 400 page. The key is not checked and nothing is logged.
- `POST /entra` needs a `Content-Length` of at most 16 KB. A `goto` target is followed only if it is a path that starts with a single `/` and contains no backslash. A wrong or blocked key redirects to the login page.
- `/api/summary` reads the key only from `X-Admin-Key`: 401 for a wrong key, 429 when blocked.
- Attempts meet three caps, in this order: the `ANON_RL` shield on every attempt (10 per minute per IP, /48, in memory, fails open); a per-IP cap (/64) of 10 failures per hour, after which that address is refused even with the right key until the hour ends; and an instance-wide cap of 50 failures per hour, after which failures are no longer written anywhere and wrong keys are refused, while the right key is still checked and accepted. Successes do not count against the two D1 caps.
- Each attempt that is written goes to `admin_audit`: endpoint, how the key was sent, result, IP (up to 64 characters) and User-Agent (up to 200). The daily cron deletes rows older than 90 days.

## Rate limits and quotas

Two mechanisms:

- **Counters in D1** (`rate_limits` table) for signed-in users, for registered addresses and for long windows. A counter is read first: over the limit the request is refused without writing. Otherwise one statement, `INSERT ... ON CONFLICT DO UPDATE SET n = n + ? WHERE n + ? <= limit RETURNING n`, increments and reads atomically, so a parallel burst cannot pass the limit and a refused request writes nothing. Windows are fixed (per minute, per hour, per UTC day) unless marked as a sliding 24 hours, which sums hourly buckets.
- **Workers Rate Limiting bindings**, `ANON_RL` (10 per 60 seconds) on anonymous routes and `USER_RL` (60 per 60 seconds) before every route that writes. They count in memory per Cloudflare location and write nothing to storage. Without the bindings, `ANON_RL` falls back to a D1 counter with the same limit and `USER_RL` to a counter in the isolate's memory.

The client IP comes only from `CF-Connecting-IP`, never from `X-Forwarded-For`. IPv4 addresses are used whole (IPv4-mapped IPv6 counts as IPv4). IPv6 is grouped by /64 for D1 counters and by /48 for `ANON_RL`. Without `CF-Connecting-IP` (local runs) the per-IP limits are skipped.

When a counter cannot be read, the routes that send email, store files or open a browser (sign-in requests, uploads, screenshots) fail closed with 503; the others fail open. A missing `rate_limits` table (migration `0004` not applied) is treated as a deploy state, not an attack: limits are skipped everywhere and the Worker logs an error.

| What | Limit | Counter | If the counter fails |
| --- | --- | --- | --- |
| Sign-in requests per IP | 10 per minute | `ANON_RL` | closed |
| Link page and link sign-in per IP | 10 per minute each | `ANON_RL` | open |
| Sign-in emails per address and IP | 3 per hour | D1, known addresses only | closed |
| Sign-in emails per address | 10 per hour; 24 per sliding 24 hours | D1, known addresses only | closed |
| All emails (sign-in and notifications) | `PINNA_EMAIL_DAILY_CAP` (default 80) per sliding 24 hours, three quarters for non-admins | D1 | closed |
| Code attempts per IP, per address | 10 per minute each | `ANON_RL` | open |
| Attempts per code | 5 | the sign-in row | |
| Wrong codes per address | 20 per sliding 24 hours | D1 | |
| Admin key requests per IP | 10 per minute | `ANON_RL` | open |
| Admin key failures per IP | 10 per hour | D1 | open |
| Admin key failures, instance-wide | 50 per hour | D1 | open |
| Write requests per user | 60 per minute | `USER_RL` | open |
| Comments per user | 30 per minute; 200 per UTC day | D1 | open |
| Comments per project | 1,000 per UTC day | D1 | open |
| Comment size | 5,000 characters of text, selector up to 1,000, page path up to 4,000; JSON body up to 64 KB | | |
| Comment storage per project | 2,000,000 characters (text, page path and selector) | checked again inside the write | |
| Uploads per user | 10 per minute; 200 files and 100 MB per UTC day | D1 | closed |
| Files per project | 1,000 files and 200 MB, uploads, screenshots and drafts together | checked again inside the write | |
| Files per comment | 10 | | |
| Screenshots | 5 per minute and 50 per UTC day per user; 150 per UTC day per project; 10 seconds each | D1 | closed |
| Proxied pages per user | 60 per minute | D1 | open |
| Notification emails | one per recipient and project every 30 minutes | D1 | |
| Request bodies | `Content-Length` required: 16 KB for JSON and forms, 64 KB for comments, 10 MB plus 64 KB for uploads, 6 MB for screenshots, 2 MB for proxied requests that have a body | checked before the body is read | |

A comment edit or a mute that changes nothing writes nothing.

Control characters are removed from comment text, on create and on edit, before validation: everything below U+0020 except tab, line feed and carriage return, plus U+007F. The cleaned text is the one stored and counted. They are removed rather than refused because honest text carries some (a text pasted from Word brings U+000B), and refusing them stopped real comments. U+0000 still cannot hide characters from the cap: SQLite's `LENGTH()` stops at the first NUL, but the NUL is gone before the count. A text that is empty after cleaning counts as empty: a new comment is refused, an edit keeps the old text. A selector that holds a control character is stored as null and the pin keeps its coordinates. A page path that holds one is refused (400).

The two project caps are part of the write itself. A new comment is inserted only if the project's characters plus its own still fit (`INSERT ... SELECT ... WHERE`), and an edit only if the sum minus the old text plus the new one fits (a text that does not grow always passes). A file row is inserted only if the project still has fewer than 1,000 files and its bytes plus the new file's size fit in 200 MB. Requests sent in parallel all pass the check made before the write, but only the ones that fit are written; the others get the usual 413.

## Revocation

- **Sign-out** (`POST /api/auth/logout` with a valid session and CSRF token) sets the user's cutoff: every session, widget token and attachment URL issued before it is refused, on every device. The cookies of the current browser are cleared in any case (if the per-user write shield has tripped, only that happens).
- **Signing a user out** (`POST /api/users/:id/revoke-sessions`, global admin and CSRF) sets the same cutoff for another user.
- **Removing a member** (`DELETE /api/projects/:id/members/:userId`) stops their widget token, attachment URLs and proxy access at the next request.
- **Demotion** through `ADMIN_EMAILS` changes the role and sets the cutoff.
- **Changing `SESSION_SECRET`** invalidates everything signed so far.
- The cutoff only moves forward.
- If `session_revocations` does not exist (migration `0003` not applied), revocations are skipped with an error in the logs. Any other database error while reading it refuses the token.
- The app has no screen for the two routes above; they are API calls with the session cookie and the CSRF token.

## Uploads and files

`POST /api/projects/:slug/attachments`, in this order:

1. `Content-Length` is required (411) and checked before the body is read: over 10 MB plus 64 KB of multipart envelope, 413. No D1 counter is touched.
2. 10 uploads per minute per user (fails closed).
3. A file over 10 MB gets 413. A project with 1,000 files, or one that would pass 200 MB, gets 413.
4. Type check: the declared type must be PNG, JPEG, WebP, GIF or PDF; the first bytes must match one of those signatures; the signature must match the declared type. Otherwise 415. SVG is refused. The file is stored with the type read from its signature.
5. The per-user daily caps (100 MB, 200 files), counted only for valid files and failing closed.
6. The database row is written first, with the project caps checked again inside the `INSERT` (see [Rate limits and quotas](#rate-limits-and-quotas)); a request that no longer fits gets 413 and nothing is stored. Then the file goes to R2. If that write fails, the row is removed.

Files are stored in R2 under a random UUID; the file name is metadata only. It is cleaned before it is stored: control characters removed, at most 200 characters, keeping an extension of up to 20 characters. Its extension is also made to agree with the type read from the file's first bytes: if it is not one of that type's (`.png`; `.jpg`, `.jpeg`, `.jpe`, `.jfif`; `.webp`; `.gif`; `.pdf`; compared without regard to case), the type's own extension is appended, so a PDF named `invoice.cmd` is stored as `invoice.cmd.pdf` and one named `scan` as `scan.pdf`. The type check ignores the name, but a download is saved under that name: without this rule a PDF called `invoice.cmd` would be saved, and could be run, as a Windows batch file. A comment can link only drafts uploaded by its own author in the same project, and only drafts younger than 24 hours, the age at which the daily cron deletes them.

`GET /api/attachments/:id` serves PNG, JPEG, WebP and GIF inline and everything else, PDF included, as a download. The file name in `Content-Disposition` goes through the same type rule again, so rows stored before the rule are covered, and is given in full as RFC 5987 `filename*`. The plain `filename=` fallback is cleaned (control characters, quotes and backslashes removed, non-ASCII replaced) and cut at 200 characters, and then gets the type's extension again, because the cut can drop it. Headers: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox`.

Deleting a draft is for its uploader only. A file linked to a comment can be deleted by its uploader, or by a project admin through the app. R2 objects are deleted first, in batches of 1,000, and the database rows only after R2 confirms; if R2 fails, the rows stay, the answer is 502 and the user can retry.

## Server-side screenshots

`POST /api/projects/:slug/shot` loads untrusted markup in a browser, so it has the most checks:

- Without the `BROWSER` binding: 503 before any D1 counter is touched.
- `Content-Length` required (411), at most 6 MB (413), checked before the body is read and before any counter.
- 5 per minute and 50 per UTC day per user, 150 per UTC day per project, all failing closed. A screenshot counts against the project's file caps with its own size: they are checked before rendering and again inside the `INSERT` of its row. A screenshot that no longer fits once rendered (another upload took the space meanwhile) is discarded with a 413 and never stored. The row is written before the JPEG; if storing the JPEG fails, the row is removed.
- The project's staging URL must be `http` or `https` and its hostname must not be internal by its text. Then the name is resolved again through DNS-over-HTTPS; an internal or unresolved name is refused.
- Two modes. In `html` mode (the default) the widget sends the page's serialized DOM, up to 3 MB; the server removes `<script>`, `<noscript>` and `<base>` elements and adds a `<base>` pointing at the staging origin. This cleaning runs in linear time and before the browser is launched, so no Browser Run (formerly Browser Rendering) session is open while the untrusted markup is processed. Beyond 3 MB, or without markup, `url` mode reloads the page from the staging site, and the URL must be on the staging origin (403 otherwise).
- **What leaves the reviewer's browser.** The `html` snapshot is the whole document as it is in the reviewer's browser, not only the visible part: hidden inputs, `value` and `data-*` attributes, meta tags and the text of inline scripts and JSON blocks all leave the browser. The widget removes only its own element; `<script>` is removed only on the server. Typed text is included only where the site's framework writes it into the `value` attribute. The content of shadow roots and of nested frames is not included. Whoever reviews a page that shows personal data sends that data to the Worker with every pin.
- **When it is sent.** On the click that places the pin, before the comment is written. Cancelling the comment does not undo it: the screenshot is still taken and kept as a draft file, listed to nobody, until the daily cron deletes drafts older than 24 hours (so it lives between 24 and 48 hours; after 24 hours it can no longer be linked to a comment). The widget sends the snapshot even when the instance has no `BROWSER` binding; the Worker then answers 503 without reading it.
- **What is kept.** Not the markup: it is used for the capture and dropped. Only the JPEG is stored, in R2. It shows the part of the page that was on the reviewer's screen, and once it is linked to a comment every member of the project can open it.
- In both modes JavaScript is off in the browser, service workers are bypassed, a script added to every document disables `WebSocket`, `WebTransport`, `RTCPeerConnection`, `Worker`, `SharedWorker` and service worker registration, and `ws://` and `wss://` are blocked through the DevTools protocol after `Network.enable`.
- Every request goes through a filter: the staging origin passes; `data:` and `about:blank` pass; from other origins only passive resources (images, stylesheets, fonts, media) over https from `PINNA_SHOT_ASSET_ORIGINS`. Documents, frames, scripts and `fetch`/XHR to other origins are blocked.
- Viewport clamped to 320 to 2560 by 320 to 2000 pixels, device pixel ratio 1 to 2. Navigation waits at most 6 seconds; the whole screenshot, browser launch included, at most 10 seconds, after which the browser is closed and the answer is 502. Error details go to the logs, not to the client.

### What a pin takes from the page

Each pin also stores a CSS selector of the clicked element, so that it can follow the element when the layout moves. The selector covers the clicked element and up to five of its ancestors, stopping at the first one with an `id`, and is built from `id` values, tag names and positions, class names that do not look generated (3 to 40 characters) and `data-*` attribute names with values of up to 60 characters. It is stored with the comment, together with the page path (without the query string), the click coordinates and the viewport width, and every member of the project can read it. The server accepts selectors of up to 1,000 characters (400 beyond). When the one the widget builds is longer, or holds a control character, the widget sends none and the pin falls back to its page coordinates; a selector with a control character that reaches the server anyway is stored as null.

## Staging URL checks

When a project is created, the staging URL must be `http` or `https`, without credentials, and its hostname must not be internal:

- Literal check: IPv4 loopback, private, link-local (cloud metadata included), CGNAT, "this network", protocol assignments, documentation, 6to4 relay, benchmark, multicast and reserved ranges; IPv6 unspecified, loopback, unique local, link-local, site-local, multicast, documentation and discard ranges, with IPv4-mapped, IPv4-compatible and NAT64 addresses checked as IPv4; names ending in `localhost`, `internal`, `local`, `localdomain`, `home.arpa`, `intranet` or `lan`; all-numeric or hexadecimal names that are not a clean IPv4 address; anything that does not parse.
- DNS check: A and AAAA records through Cloudflare's DNS-over-HTTPS. One internal address is enough to refuse. A name that does not resolve yet is accepted (a new domain), and `/shot` refuses it until it resolves.

In local dev mode internal hosts are allowed. No route changes a staging URL after creation.

## Headers, CSP and CORS

| Response | Headers |
| --- | --- |
| Everything | `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` |
| `/api/*` | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`. Routes with their own policy (the link page, files) keep theirs |
| The app's HTML | `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-src https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` |
| `/_proxy`, when on | `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *` |

CORS is open (`Access-Control-Allow-Origin: *`, without credentials, methods `GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`, headers `Content-Type` and `Authorization`) only on the routes the widget calls from the staging site: comments, attachments and `/shot`. With a widget token these routes do only what the token allows; with a cookie they also need the CSRF header, which another origin cannot read. Every other API route sends no CORS headers, so browsers block cross-origin calls to them.

## The review frame

The app shows the staging site in a sandboxed iframe.

- Direct mode: `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`. The site keeps its own origin, which the widget needs for its `sessionStorage` and the `postMessage` handshake, but there is no top-navigation token: a script on the site, or a link that targets the top window, cannot navigate the reviewer's Pinna tab away. Popups and new tabs still open, outside the sandbox.
- Proxy mode: `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"`, without `allow-same-origin`, on top of the sandbox CSP of every proxy response.

## The review proxy

`/_proxy` answers 503 unless `PINNA_PROXY_ENABLED=1`. When it is on:

- It authenticates only with the proxy token in the URL, never with the session cookie.
- Every response, pages, sub-resources and errors, carries the sandbox CSP above without `allow-same-origin`. The proxied page runs in an opaque origin and cannot read Pinna's cookies, storage or API responses.
- Target and redirects: only `http`/`https` URLs on the project's staging origin; at most 5 redirects, each one checked again for scheme, internal hostname and origin. The hostname check is on the text, without a DNS lookup.
- The membership is checked on every request, sub-resources included.
- A request with a body needs a `Content-Length` (411 without) of at most 2 MB (413 over), checked before the body is read. Requests without a body pass.
- The Worker never forwards Pinna's cookies to the site and never relays the site's `Set-Cookie`. `<meta http-equiv>` framing rules (`Content-Security-Policy`, `X-Frame-Options`) are removed from the HTML.
- Links to other sites open in a new tab with `rel="noopener noreferrer"`.
- The widget inside a proxied page talks to the app from origin `null`. It introduces itself with the proxy token; the app answers only if the message comes from its own iframe and carries a token it issued, then opens a channel with a secret that every later message must carry.
- 60 pages per minute per user. An HTML response requested as a sub-resource counts as a page.

The risk that remains is in [Known limits](#known-limits): the proxy token sits in a URL that the staging site's scripts can read.

## Secrets and configuration

- `SESSION_SECRET` must be at least 32 characters. Shorter or missing: `/api/*`, `/entra` and `/_proxy` answer 503 and the Worker logs it once per isolate.
- `ADMIN_KEY` must be at least 32 characters. Shorter or missing: no admin key is accepted.
- Without `RESEND_API_KEY`, sign-in requests answer 503.
- Generate secrets with `openssl rand -hex 32`. If `ADMIN_KEY` leaks, set a new one with `wrangler secret put ADMIN_KEY`, update the bookmark and any script that sends `X-Admin-Key`, and look at `admin_audit` for addresses you do not recognise.
- The code has no built-in recipient and no public address of its own. Alerts go only to `ALERT_EMAIL`; links and the logo in emails use `PINNA_PUBLIC_URL` or, without it, the origin of the request. Besides the Cloudflare bindings, the Worker calls only Resend's API, Cloudflare's DNS-over-HTTPS resolver and, with the proxy on, the project's staging site.
- `PINNA_DEV_MODE=1` has an effect only when the request's host is `localhost`, `127.0.0.1` or `[::1]`. The dev server runs with `--local-upstream localhost:8787`, which makes every request look like `localhost`, so it listens on `127.0.0.1` only (`--ip 127.0.0.1` in the script, `[dev] ip` in `wrangler.toml`). With `--ip 0.0.0.0` and dev mode on, anyone on the same network could sign in as anyone.

## Deploy order

`bun run deploy` applies the remote D1 migrations first, then builds, then deploys the Worker; if the migrations fail, the Worker is not deployed. A Worker that arrives before its migrations does not answer 500: without `0002` every membership counts as `client` (collaborators lose admin rights until the migration runs), without `0003` revocations are not applied, without `0004` the D1 limits are skipped while `ANON_RL` and `USER_RL` keep working. Each case is logged. Turn on `PINNA_PROXY_ENABLED` last, and only if you need it.

## Data retention

A cron trigger runs every day at 03:00 UTC. It deletes sign-in rows 7 days after they expire (they contain the email address), `admin_audit` rows older than 90 days, rate limit windows older than 2 days, and draft files older than 24 hours (R2 objects first, rows after; on an R2 error the rows stay and the next run retries). A draft of that age is also refused when a comment tries to link it, so a file the cron may be deleting never ends up attached. It also demotes admins no longer in `ADMIN_EMAILS` and, if errors were counted, sends a digest to `ALERT_EMAIL`.

## Not implemented

- Two-factor authentication. Admin access rests on the email inbox and on `ADMIN_KEY`.
- An audit log beyond `admin_audit`, which records only admin key attempts.
- Malware scanning of uploads.
- Per-user data export or deletion, and deleting a project.
- Backups. Nothing in this repository configures backups of D1 or R2.

## Known limits

What is still open, with the consequence of each item.

- **Proxy token in the frame's URL** (only with the proxy on, `PINNA_PROXY_ENABLED=1`). The token travels as `?pinna_pt=` in the URL of the staging page inside the frame. Analytics, tag managers and other third-party scripts on the staging site read the URL, and with it the token: for one hour (the token's lifetime) they can use `/_proxy` on that staging site as the user. The token is valid only for that origin and gives no access to Pinna's data. Sign-out (logout) and session revocation do not cancel it; removing the membership (`DELETE /api/projects/:id/members/:userId`) or the expiry does. This is why the proxy is off by default.
- **DNS rebinding.** The staging hostname is checked through DNS-over-HTTPS when the project is created and before every `/shot`, but the Chrome of Browser Run resolves the name on its own. A name that answers the check with a public address and right after (TTL 0) with an internal one passes. What it can reach that way is Browser Run's network, not the installer's. The proxy checks only the hostname text, and the Worker's `fetch` calls leave from Cloudflare's network, not from the installer's.
- **Global email cap: with a few known client addresses, email sign-in stops for all clients for 24 hours.** The cap (by default 80 emails in 24 hours: 60 for clients and notifications, 20 kept for admin sign-in) is one for the whole instance, and anyone who knows a client's address can make emails leave in that client's name without signing in: 5 at once per address (one, plus 4 more after burning each code with 5 wrong attempts), then one every 90 minutes. With 12 known addresses the 60 places are gone in minutes; with 3, in less than a day. From then until the oldest emails leave the 24-hour window, no client receives the sign-in email: neither the code nor the link, because both travel in the same email. Notifications stop too. People who already have a session (30 days) keep working; admins sign in with their reserve or with `/entra`. Every email that leaves reaches the real client with a valid code (no access for the person insisting), and an alert fires at most once an hour. Remedy, if it happens: raise `PINNA_EMAIL_DAILY_CAP` together with the Resend plan.
- **Code sign-in can be switched off from outside.** 20 wrong codes in 24 hours turn off code sign-in for that address (the button in the email still works). Anyone who knows the address can do it.
- **Response time of `/api/auth/request`.** The "unknown address" branch waits 100 to 300 ms; the "code still valid" and "cap reached" branches do not. After a first request, the timing tells a registered address apart. An address listed in `ADMIN_EMAILS` is created at its first request and then handled as registered, so the timing also reveals that an address is on the list (not access to it).
- **In-memory shields are approximate.** `ANON_RL` and `USER_RL` count per Cloudflare location: requests spread over several locations get more through. Without the bindings (development, tests) `USER_RL` counts in the isolate's memory.
- **Per-IP cap on the admin key.** 10 failures in an hour from the same /64 block the right key too, for that hour, from that address (for example behind the same NAT as whoever is insisting). Email sign-in still works.
- **Widget token in the staging page.** Third-party scripts of the site under review (a shop's apps, a tag manager) can read it, for example by wrapping `fetch` and copying the `Authorization` header. That way they also get the refreshed tokens while the page stays open in the frame, and the last one is valid for one more hour. With the token, as the user and only on that project, they can: read the project's comments and files (the list also gives the `?at=` URL that opens every file of the project for 10 minutes), create comments, edit the user's own, delete the user's own replies and the user's own pins whose whole thread is the user's, upload files and request screenshots (using up the quotas, see the next item). They cannot resolve or reopen, delete other people's work (not even as part of a thread), invite, perform admin actions or touch other projects: those need the app's session and the confirmation in the app's page. The token dies with sign-out or revocation (it carries its issue time) and as soon as the membership is removed.
- **Project quotas can be filled with a widget token.** The cumulative quotas belong to the project, and whoever holds a user's token spends them in that user's name. Per-user caps slow it down: 200 comments, 200 files and 100 MB per day, 50 screenshots per day (the project has 150), 10 files per comment. Project caps that can still be filled within a few days: 1,000 files and 200 MB, 2 million characters (text, page path and selector). The project caps are enforced inside the write, so parallel requests cannot go past them, but they can still be reached. Once a cap is full, nobody can attach files or comment on that project until an admin deletes something; other projects are not affected. The same holds for a member acting in bad faith with their own session: only these per-user limits bound them.
- **An `ADMIN_EMAILS` list that is empty, or contains none of the admins in the database, does not remove admins.** It is treated as missing configuration, and so is a well-formed list that contains none of the current admins (a typo, for example). Removing an admin takes a valid list that does not contain them and does contain at least one other admin from the database. An instance passes to a new admin in two steps: add the new address, let them sign in, remove the old one.
- **`/shot` in URL mode runs with JavaScript off.** A page that draws itself only with JavaScript comes out blank in the URL fallback. The `html` mode, the default, is not affected.
- **The admin confirmation bar can be triggered by the staging site.** A script on the site can send the same `postMessage` the widget sends, so an admin reviewing the site can see a confirmation bar they did not ask for. The bar shows the real action and an excerpt of the real comment or the file name, taken from the API; nothing happens unless the admin clicks it.
- **Project slugs can be probed by signed-in users.** A project that does not exist gets 404, one the user cannot access gets 403, so any signed-in user can tell whether a slug exists. Slugs come from project names.
- **A thread can change between the check and the delete.** Deleting a pin first checks the thread for other people's work, then reads the thread's file list, deletes those files from R2 and finally deletes the rows. A reply, or a file, added by someone else in between is deleted with the thread without the admin rule; if it arrives after the file list was read, its object stays in R2 without a row, where the draft sweep does not see it. The window is a few database and storage calls long.
- **Stored selectors run in every viewer's browser.** The server stores whatever selector string the creator of a pin sends (a member, or a script holding a member's widget token); it checks only the length. The widget of everyone who views that page passes it to `querySelector`, at every refresh (every 20 seconds while the tab is visible) and on resize. A selector written to be slow costs CPU in the reviewers' browsers. It is capped at 1,000 characters; the cost of the worst selector of that length has not been measured.
- **Alert emails can repeat.** The alert cooldown in KV is read and then written in two steps, and KV is not atomic: errors arriving together can each find no cooldown and each send an alert, so a burst can produce a few alert emails instead of one. The error counters are approximate for the same reason.
