import { describe, expect, it } from 'vitest';
import { buildSyncScheduleCron } from '../agent.js';

describe('buildSyncScheduleCron', () => {
  it('returns an hourly interval cron for values below 24', () => {
    expect(buildSyncScheduleCron(6)).toBe('0 */6 * * *');
    expect(buildSyncScheduleCron(1)).toBe('0 */1 * * *');
  });

  it('returns daily cron for 24 hour interval', () => {
    expect(buildSyncScheduleCron(24)).toBe('0 0 * * *');
  });

  it('throws on invalid interval', () => {
    expect(() => buildSyncScheduleCron(0)).toThrow('Invalid sync interval');
  });
});