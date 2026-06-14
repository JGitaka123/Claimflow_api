import { describe, expect, it } from 'vitest';
import {
  currentLogContext,
  enterLogContext,
  logContextMixin,
  runWithLogContext,
} from '../logging/context.js';

describe('log context (item 7 — observability)', () => {
  it('returns empty when no context is bound', () => {
    expect(currentLogContext()).toEqual({});
    expect(logContextMixin()).toEqual({});
  });

  it('runWithLogContext exposes the bound fields, then unwinds', async () => {
    expect(currentLogContext()).toEqual({});
    await runWithLogContext({ requestId: 'r1', tenantId: 't1', userId: 'u1' }, async () => {
      expect(currentLogContext()).toEqual({ requestId: 'r1', tenantId: 't1', userId: 'u1' });
      const mixed = logContextMixin();
      expect(mixed).toMatchObject({ requestId: 'r1', tenantId: 't1', userId: 'u1' });
    });
    expect(currentLogContext()).toEqual({});
  });

  it('enterLogContext layers fields on top of the current context (additive merge)', async () => {
    await runWithLogContext({ requestId: 'r2' }, async () => {
      enterLogContext({ tenantId: 't2', principalKind: 'api_key', principalId: 'cf_abc' });
      expect(logContextMixin()).toMatchObject({
        requestId: 'r2',
        tenantId: 't2',
        principalKind: 'api_key',
        principalId: 'cf_abc',
      });
    });
  });

  it('omits unset fields from the mixin output so log lines stay tight', async () => {
    await runWithLogContext({ tenantId: 't3' }, async () => {
      const out = logContextMixin();
      expect(out).toEqual({ tenantId: 't3' });
      expect(out).not.toHaveProperty('userId');
      expect(out).not.toHaveProperty('requestId');
    });
  });
});
