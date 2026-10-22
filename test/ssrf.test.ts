import { describe, expect, it } from 'vitest';
import { assertPublicHost, isBlockedHostname, isPrivateAddress, makePinnedLookup } from '../src/net/ssrf.js';
import { SsrfBlockedError } from '../src/core/errors.js';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255'])('flags %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '93.184.216.34'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
  it.each(['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2001:db8::1', 'ff02::1', '[::1]', 'fe80::1%en0'])('flags IPv6 %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['2606:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001:80b::200e'])('allows IPv6 %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it.each(['localhost', 'LOCALHOST.', 'api.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', '127.0.0.1', '[::1]', 'router.lan'])('blocks %s', (h) => {
    expect(isBlockedHostname(h)).toBe(true);
  });
  it.each(['example.com', 'localhost.example.com', 'internal-tools.example.com'])('allows %s', (h) => {
    expect(isBlockedHostname(h)).toBe(false);
  });
});

describe('assertPublicHost', () => {
  it('rejects hosts that resolve to private addresses', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    await expect(assertPublicHost('evil.example', { allowPrivate: false, resolver })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('accepts public resolutions and returns them', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(assertPublicHost('example.com', { allowPrivate: false, resolver })).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
  it('allows private targets only when explicitly permitted', async () => {
    await expect(assertPublicHost('127.0.0.1', { allowPrivate: false })).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertPublicHost('127.0.0.1', { allowPrivate: true })).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
  it('rejects names that do not resolve', async () => {
    const resolver = async () => [];
    await expect(assertPublicHost('nowhere.example', { allowPrivate: false, resolver })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('makePinnedLookup', () => {
  it('fails the connection when the dialed address is private', async () => {
    const lookup = makePinnedLookup({ allowPrivate: false, resolver: async () => [{ address: '169.254.169.254', family: 4 }] });
    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => lookup('meta.example', {}, (err) => resolve({ err })));
    expect(result.err?.code).toBe('ESSRFBLOCKED');
  });
  it('returns all addresses when asked and a single one otherwise', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
    const lookup = makePinnedLookup({ allowPrivate: false, resolver });
    const all = await new Promise<unknown>((resolve) => lookup('example.com', { all: true }, (_e, a) => resolve(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
    const one = await new Promise<unknown>((resolve) => lookup('example.com', { family: 6 }, (_e, a, f) => resolve([a, f])));
    expect(one).toEqual(['2606:2800:220:1:248:1893:25c8:1946', 6]);
  });
});
