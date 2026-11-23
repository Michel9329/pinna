/**
 * Pinna - host names that point to internal addresses.
 *
 * isBlockedHost only looks at the text of the host: 127.0.0.1.nip.io, or any
 * domain with an A record pointing to 10.0.0.5, would get through. Here the
 * name is resolved (Cloudflare DNS-over-HTTPS, JSON format) and every address
 * found goes through isBlockedHost. Used when a project is created
 * (staging_url) and before every /shot, whose Chrome runs outside the
 * Cloudflare network of the Workers.
 *
 * Known limit: between the check and the browser's own resolution the DNS can
 * change (rebinding). The check closes fixed names like nip.io and records
 * left behind by mistake, not a hostile DNS that changes within a second.
 */
import { isBlockedHost } from './proxy';

export type DnsVerdict = 'public' | 'internal' | 'unresolved';

/** Addresses of a name. Replaceable in tests (setResolver). */
export type Resolver = (hostname: string) => Promise<string[]>;

const DOH = 'https://cloudflare-dns.com/dns-query';

/** Resolves A and AAAA via DNS-over-HTTPS. Errors or no answer = []. */
export async function dohResolve(hostname: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ['A', 'AAAA']) {
    try {
      const res = await fetch(DOH + '?name=' + encodeURIComponent(hostname) + '&type=' + type, {
        headers: { accept: 'application/dns-json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
      for (const a of data.Answer || []) {
        if ((a.type === 1 || a.type === 28) && typeof a.data === 'string') out.push(a.data.trim());
      }
    } catch {
      /* no answer: decided below */
    }
  }
  return out;
}

let resolver: Resolver = dohResolve;

/** Tests only: a fake resolver (no network). Null = the real one. */
export function setResolver(r: Resolver | null): void {
  resolver = r || dohResolve;
}

/**
 * 'internal' if the name (or one of its addresses) is internal, 'public' if it
 * has at least one address and all of them are public, 'unresolved' if it
 * does not resolve.
 */
export async function hostVerdict(hostname: string): Promise<DnsVerdict> {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isBlockedHost(h)) return 'internal';
  // A literal address has nothing to resolve.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return 'public';
  const ips = await resolver(h);
  if (!ips.length) return 'unresolved';
  return ips.some((ip) => isBlockedHost(ip)) ? 'internal' : 'public';
}

/**
 * A project's staging_url (on creation): empty is allowed (project without a
 * site), otherwise only http(s), no credentials in the URL, no internal hosts
 * (not even by name). A name that does not resolve yet is allowed (new
 * domain): /shot checks it again on every use. `allowInternal`: only in
 * development mode, to try Pinna with a site on localhost.
 */
export async function checkStagingUrl(
  raw: string,
  allowInternal = false,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const url = raw.trim();
  if (!url) return { ok: true, url: '' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'invalid staging url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'the staging url must be http or https' };
  }
  if (u.username || u.password) return { ok: false, error: 'the staging url must not contain credentials' };
  if (allowInternal) return { ok: true, url };
  if ((await hostVerdict(u.hostname)) === 'internal') {
    return { ok: false, error: 'the staging url points to an internal address' };
  }
  return { ok: true, url };
}
