import { describe, expect, it } from 'vitest';
import { normalizeSha256, parseSemver } from '../rulepack-sync.js';

describe('rulepack sync helpers', () => {
  it('normalizes sha256 checksum prefixes', () => {
    expect(normalizeSha256('SHA256:ABC123')).toBe('abc123');
    expect(normalizeSha256('  abc123  ')).toBe('abc123');
  });

  it('parses semver values with and without v prefix', () => {
    expect(parseSemver('v1.2.3')).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      normalized: '1.2.3',
      prefixed: 'v1.2.3',
    });

    expect(parseSemver('2.4.6').prefixed).toBe('v2.4.6');
  });

  it('rejects invalid semver values', () => {
    expect(() => parseSemver('v1.2')).toThrow('Invalid semantic version');
    expect(() => parseSemver('latest')).toThrow('Invalid semantic version');
  });
});