import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';
import { SsrfBlockedError } from '../core/errors.js';
import { stripBrackets } from './url.js';

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.localdomain', '.intranet', '.lan'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data', 'ip6-localhost', 'ip6-loopback']);

export function isBlockedHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase().replace(/\.$/, ''));
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIPv4(host) || isIPv6(host)) return isPrivateAddress(host);
  return false;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

/** Private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges. */
const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const n = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Expand an IPv6 address to eight 16-bit groups. Handles `::` and embedded IPv4. */
export function expandIPv6(ip: string): number[] | null {
  let addr = stripBrackets(ip);
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  if (!isIPv6(addr)) return null;

  // Convert trailing dotted IPv4 to two hex groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    addr = `${addr.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // :: and ::1
  if (allZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroPrefix && (g5 === 0xffff || g5 === 0)) {
    return isPrivateIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local, fec0::/10 site-local (deprecated)
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const bare = stripBrackets(ip);
  if (isIPv4(bare)) return isPrivateIPv4(bare);
  if (isIPv6(bare.split('%')[0]!)) return isPrivateIPv6(bare);
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

export interface SsrfGuardOptions {
  allowPrivate: boolean;
  resolver?: Resolver;
}

/**
 * Resolve a hostname and reject it when any address is private, unless private
 * targets are explicitly allowed. Returns the checked addresses.
 */
export async function assertPublicHost(hostname: string, options: SsrfGuardOptions): Promise<ResolvedAddress[]> {
  const host = stripBrackets(hostname.toLowerCase());
  if (!options.allowPrivate && isBlockedHostname(host)) {
    throw new SsrfBlockedError(`Host ${hostname} is a blocked local or private target`);
  }
  if (isIPv4(host) || isIPv6(host)) {
    return [{ address: host, family: isIPv4(host) ? 4 : 6 }];
  }
  const resolver = options.resolver ?? systemResolver;
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new SsrfBlockedError(`Host ${hostname} did not resolve: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) throw new SsrfBlockedError(`Host ${hostname} did not resolve to any address`);
  if (!options.allowPrivate) {
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) throw new SsrfBlockedError(`Host ${hostname} resolves to private address ${bad.address}`);
  }
  return addresses;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` implementation for socket connections that performs the SSRF check
 * on the addresses actually dialed, closing the gap between "checked" and "connected".
 */
export function makePinnedLookup(options: SsrfGuardOptions) {
  const resolver = options.resolver ?? systemResolver;
  return function pinnedLookup(hostname: string, lookupOptions: LookupOptions, cb: LookupCallback): void {
    const opts = lookupOptions ?? {};
    const wantFamily = opts.family === 4 || opts.family === 'IPv4' ? 4 : opts.family === 6 || opts.family === 'IPv6' ? 6 : undefined;

    const fail = (message: string) => {
      const err: NodeJS.ErrnoException = new Error(message);
      err.code = 'ESSRFBLOCKED';
      cb(err, '');
    };

    if (!options.allowPrivate && isBlockedHostname(hostname)) {
      fail(`blocked host ${hostname}`);
      return;
    }

    resolver(hostname)
      .then((addresses) => {
        let candidates = addresses;
        if (wantFamily) candidates = candidates.filter((a) => a.family === wantFamily);
        if (candidates.length === 0) {
          fail(`no addresses for ${hostname}`);
          return;
        }
        if (!options.allowPrivate) {
          const bad = candidates.find((a) => isPrivateAddress(a.address));
          if (bad) {
            fail(`${hostname} resolves to private address ${bad.address}`);
            return;
          }
        }
        if (opts.all) cb(null, candidates.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, candidates[0]!.address, candidates[0]!.family);
      })
      .catch((err: unknown) => {
        const e: NodeJS.ErrnoException = err instanceof Error ? err : new Error(String(err));
        e.code ??= 'ENOTFOUND';
        cb(e, '');
      });
  };
}
