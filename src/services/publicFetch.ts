/**
 * GET an https URL from the public internet only. For links a bot hands Sky: a prompt-injected
 * bot must not make Sky fetch internal addresses (localhost, cloud metadata, private networks).
 *
 * The address is checked inside the socket's DNS lookup, so the IP that is checked is the IP
 * connected to (no DNS-rebinding gap), and every redirect hop goes through the same check.
 */
import https from 'https';
import dns from 'dns';
import net from 'net';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4 written as IPv6
  if (mapped) return isPublicAddress(mapped[1]);
  const family = net.isIP(ip);
  return family !== 0 && !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class FetchRefused extends Error {}

const publicLookup: net.LookupFunction = (host, options, cb) => {
  dns.lookup(host, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 4);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || !list.length) return cb(new FetchRefused(`${host} is not a public address`), '', 4);
    if ((options as dns.LookupAllOptions).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

export interface PublicResponse { status: number; type: string; data: Buffer }

export function fetchPublic(url: string, opts: { headers?: Record<string, string>; maxBytes: number; timeoutMs?: number }, hops = 3): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new FetchRefused('not a valid link'));
    }
    if (u.protocol !== 'https:') return reject(new FetchRefused('only https links'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // An IP written in the link skips DNS (and so the lookup check), so check it here.
    if (net.isIP(host) && !isPublicAddress(host)) return reject(new FetchRefused(`${host} is not a public address`));

    const req = https.get(u, { headers: opts.headers, lookup: publicLookup, timeout: opts.timeoutMs ?? 15_000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops === 0) return reject(new FetchRefused('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        // Credentials stay with the host they were meant for.
        const headers = new URL(next).host === u.host ? opts.headers : undefined;
        return fetchPublic(next, { ...opts, headers }, hops - 1).then(resolve, reject);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) {
          req.destroy(new FetchRefused(`larger than ${Math.round(opts.maxBytes / 1048576)} MB`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, type: String(res.headers['content-type'] ?? ''), data: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FetchRefused('timed out')));
    req.on('error', reject);
  });
}
