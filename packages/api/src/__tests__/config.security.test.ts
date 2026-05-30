import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('config security hardening', () => {
  it('rejects loopback ML service URL in production', () => {
    expect(() =>
      loadConfig({
        exitOnError: false,
        env: {
          DATABASE_URL: 'postgres://claimflow:dev@localhost:5432/claimflow',
          NODE_ENV: 'production',
          ML_SERVICE_URL: 'http://127.0.0.1:8000',
        },
      }),
    ).toThrow('Invalid configuration');
  });

  it('accepts internal ML service URL in production', () => {
    const config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: 'postgres://claimflow:dev@localhost:5432/claimflow',
        NODE_ENV: 'production',
        ML_SERVICE_URL: 'http://ml-service:8000',
      },
    });

    expect(config.ML_SERVICE_URL).toBe('http://ml-service:8000');
  });
});
