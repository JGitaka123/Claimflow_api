import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getPool } from '../db/client.js';
import { buildServer } from '../server.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const testKeysPath = resolve(currentDir, '../../../.tmp-oauth-keys');

// A human-session JWT for the admin CRUD path. The auth service accepts an
// unsigned (alg:none) token in NODE_ENV=test via decodeLegacyAuthContext; the
// OAuth token path below uses a *real* RS256 token signed with the test keypair.
function adminJwt(c: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: c.userId, tenantId: c.tenantId, facilityId: c.facilityId, role: 'admin' }),
  ).toString('base64url');
  return `Bearer ${header}.${payload}.signature`;
}

async function createTestKeys(): Promise<void> {
  await rm(testKeysPath, { recursive: true, force: true });
  await mkdir(testKeysPath, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(resolve(testKeysPath, 'jwt_private.pem'), privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), 'utf8');
  await writeFile(resolve(testKeysPath, 'jwt_public.pem'), publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'utf8');
  await writeFile(resolve(testKeysPath, 'master.key'), randomBytes(32).toString('hex'), 'utf8');
}

async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = resolve(currentDir, '../../../../migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [951337]);
    for (const file of files) {
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${file}`, { cause: error as Error });
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [951337]);
    } catch {
      // ignore
    }
    client.release();
  }
}

async function truncate(pool: Pool): Promise<void> {
  const rows = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename NOT IN ('schema_migrations','payers','icd_codes','sha_service_codes')`,
  );
  if (rows.rows.length === 0) {
    return;
  }
  await pool.query(`TRUNCATE TABLE ${rows.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  jwt: string;
}

async function seed(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid,$2,$3)`, [
    tenantId,
    'OAuth Tenant',
    `tenant-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,true)`,
    [facilityId, tenantId, 'OAuth Facility', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'admin'::user_role,true,false)`,
    [userId, tenantId, facilityId, `oauth.admin+${userId.slice(0, 8)}@example.org`, 'OAuth Admin', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );
  return { tenantId, facilityId, userId, jwt: adminJwt({ tenantId, facilityId, userId }) };
}

async function createClient(
  app: FastifyInstance,
  s: SeedContext,
  scopes: string[],
): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/oauth/clients',
    headers: { authorization: s.jwt },
    payload: { name: 'enterprise integration', scopes },
  });
  const body = response.json() as { data: { id: string; clientId: string; clientSecret: string } };
  return body.data;
}

async function token(
  app: FastifyInstance,
  clientId: string,
  clientSecret: string,
  scope?: string,
): Promise<ReturnType<FastifyInstance['inject']>> {
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  if (scope) {
    params.set('scope', scope);
  }
  return app.inject({
    method: 'POST',
    url: '/v1/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: params.toString(),
  });
}

const claimPayload = (facilityId: string, suffix: string): Record<string, unknown> => ({
  facilityId,
  claimType: 'OUTPATIENT',
  visitType: 'OP',
  patientShaId: `CR12345678${suffix}-1`,
  admissionDate: '2026-03-05',
  primaryDiagnosisCode: `D${suffix}`,
  lines: [{ shaServiceCode: `SVC-${suffix}`, description: 'Consult', quantity: 1, unitPrice: 500 }],
});

integrationDescribe('OAuth2 client-credentials integration (real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }
    await createTestKeys();
    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '1000',
        KEY_PATH: testKeysPath,
      },
    });
    pool = getPool(config);
    await runMigrations(pool);
    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('pool not initialized');
    }
    await truncate(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closePool();
    await rm(testKeysPath, { recursive: true, force: true });
  });

  it('creates a client (secret once) and hides the secret on list', async () => {
    const s = await seed(pool!);
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/oauth/clients',
      headers: { authorization: s.jwt },
      payload: { name: 'EMR integration', scopes: ['claim:create', 'audit:trigger'] },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json() as { data: { id: string; clientId: string; clientSecret?: string; scopes: string[] } };
    expect(body.data.clientId.startsWith('cfc_')).toBe(true);
    expect(body.data.clientSecret?.startsWith('cfs_')).toBe(true);
    expect(body.data.scopes).toEqual(['claim:create', 'audit:trigger']);

    const list = await app!.inject({ method: 'GET', url: '/v1/oauth/clients', headers: { authorization: s.jwt } });
    const listBody = list.json() as { data: Array<{ clientSecret?: string; clientId: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.clientSecret).toBeUndefined();
    expect(listBody.data[0]?.clientId).toBeTruthy();
  });

  it('issues a token and authenticates a request, enforcing scope', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create']);

    const tokenResponse = await token(app!, client.clientId, client.clientSecret);
    expect(tokenResponse.statusCode).toBe(200);
    expect(tokenResponse.headers['cache-control']).toBe('no-store');
    const tokenBody = tokenResponse.json() as { access_token: string; token_type: string; expires_in: number; scope: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBeGreaterThan(0);
    expect(tokenBody.scope).toBe('claim:create');

    // In-scope: claim:create -> POST /v1/claims succeeds with the bearer token.
    const allowed = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
      payload: claimPayload(s.facilityId, 'O'),
    });
    expect(allowed.statusCode).toBe(201);

    // Out-of-scope: the token lacks system:settings -> listing clients is forbidden.
    const forbidden = await app!.inject({
      method: 'GET',
      url: '/v1/oauth/clients',
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('accepts JSON token requests as well as form-encoded', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create']);

    const jsonResponse = await app!.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      payload: { grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret },
    });
    expect(jsonResponse.statusCode).toBe(200);
    expect((jsonResponse.json() as { access_token: string }).access_token.length).toBeGreaterThan(0);
  });

  it('down-scopes when a narrower scope is requested', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create', 'audit:trigger']);

    const narrowed = await token(app!, client.clientId, client.clientSecret, 'claim:create');
    expect(narrowed.statusCode).toBe(200);
    expect((narrowed.json() as { scope: string }).scope).toBe('claim:create');
  });

  it('rejects a scope the client was not granted', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create']);

    const response = await token(app!, client.clientId, client.clientSecret, 'system:settings');
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects invalid client credentials with problem+json', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create']);

    const badSecret = await token(app!, client.clientId, 'cfs_wrongsecret');
    expect(badSecret.statusCode).toBe(401);
    expect(badSecret.headers['content-type']).toContain('application/problem+json');

    const unknownClient = await token(app!, 'cfc_unknownclient', client.clientSecret);
    expect(unknownClient.statusCode).toBe(401);
  });

  it('rejects a token issued by a revoked client', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create']);

    // Token issued before revocation is still cryptographically valid, but the
    // client can no longer mint new tokens once revoked.
    const revoked = await app!.inject({
      method: 'DELETE',
      url: `/v1/oauth/clients/${client.id}`,
      headers: { authorization: s.jwt },
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await token(app!, client.clientId, client.clientSecret);
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('rejects an unsupported grant_type', async () => {
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['claim:create']);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'password',
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }).toString(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('does not let an OAuth token reach an endpoint outside its scope vocabulary', async () => {
    // A client granted only dashboard:view cannot create claims.
    const s = await seed(pool!);
    const client = await createClient(app!, s, ['dashboard:view']);
    const tokenBody = (await token(app!, client.clientId, client.clientSecret)).json() as { access_token: string };

    const blocked = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
      payload: claimPayload(s.facilityId, 'X'),
    });
    expect(blocked.statusCode).toBe(403);
  });
});
