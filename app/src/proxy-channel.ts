/**
 * Pinna app - channel with the widget in proxy mode.
 *
 * In proxy mode the page runs in a sandbox (origin "null") and the app
 * recognizes its widget by the proxy-token (pt). But the pt is in the frame
 * URL: without more checks, any "null" document that knows it could say hello
 * and receive the widget-token. So:
 *  - the hello ('pinna-hello') is accepted ONCE per document: after the first,
 *    further hellos with the same pt are ignored until a new document arrives
 *    (a navigation decided by the app, or a 'pinna-bye' from the widget that
 *    is leaving the page, signed with the secret);
 *  - the init carries a random channel secret: every other widget message
 *    (refresh, admin actions, navigation, bye) must carry it back.
 */

function randomSecret(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class ProxyChannel {
  private issued = new Set<string>();
  private helloOpen = true;
  private secret = '';

  constructor(private readonly random: () => string = randomSecret) {}

  /** Proxy-token issued by this view (to recognize the frame). */
  issue(pt: string | null | undefined): void {
    if (pt) this.issued.add(pt);
  }

  knows(pt: unknown): boolean {
    return typeof pt === 'string' && this.issued.has(pt);
  }

  /** The app is loading a new document in the frame: one hello allowed. */
  expectNewDocument(): void {
    this.helloOpen = true;
    this.secret = '';
  }

  /** Widget hello: the secret to put in the init, or null if refused. */
  hello(pt: unknown): string | null {
    if (!this.helloOpen || !this.knows(pt)) return null;
    this.helloOpen = false;
    this.secret = this.random();
    return this.secret;
  }

  /** The message carries the secret of the open channel. */
  check(ch: unknown): boolean {
    return !!this.secret && typeof ch === 'string' && ch === this.secret;
  }

  /** The widget is leaving the page (internal navigation): a new hello is allowed. */
  bye(ch: unknown): boolean {
    if (!this.check(ch)) return false;
    this.expectNewDocument();
    return true;
  }

  /** Secret of the open channel ('' if none). */
  get current(): string {
    return this.secret;
  }
}
