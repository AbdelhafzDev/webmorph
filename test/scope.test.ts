import { describe, expect, it } from 'vitest';
import { ScopePolicy } from '../src/net/scope.js';

describe('ScopePolicy', () => {
  const policy = new ScopePolicy(
    { origin: 'https://example.com', allowedHosts: ScopePolicy.allowedHostsFor('https://example.com/start', ['cdn.example.com']), allowPrivateNetwork: false, respectRobots: true, userAgent: 'test' },
    { hosts: ['cdn.example.com'], pathPatterns: ['^/admin', 'logout'] },
  );

  it('adds the www counterpart automatically', () => {
    expect(policy.allowedHosts).toEqual(new Set(['example.com', 'cdn.example.com', 'www.example.com']));
  });
  it('matches exact hostnames only', () => {
    expect(policy.isInScope('https://www.example.com/a')).toBe(true);
    expect(policy.isInScope('https://EXAMPLE.com/a')).toBe(true);
    expect(policy.isInScope('https://shop.example.com/a')).toBe(false);
    expect(policy.isInScope('https://example.com.evil.net/a')).toBe(false);
    expect(policy.isInScope('ftp://example.com/a')).toBe(false);
  });
  it('honors prohibited hosts and paths', () => {
    expect(policy.isInScope('https://cdn.example.com/x')).toBe(false);
    expect(policy.isProhibitedPath('https://example.com/admin/users')).toBe(true);
    expect(policy.isProhibitedPath('https://example.com/account?action=LOGOUT')).toBe(true);
    expect(policy.isProhibitedPath('https://example.com/products')).toBe(false);
  });
});
