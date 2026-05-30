import { expect, test } from '@playwright/test';
import { apiOk, mockDashboardApis, setAuthenticatedSession, waitForHydration } from './helpers';

const NAV_TIMEOUT_MS = 15_000;

test('redirects non-admin users away from admin page', async ({ page }) => {
  await setAuthenticatedSession(page);
  await mockDashboardApis(page);

  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const dashboardHeading = page.getByRole('heading', { name: 'Operations Dashboard' });
  const redirectingLabel = page.getByText('Redirecting...');

  await expect(redirectingLabel.or(dashboardHeading)).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: 'Administration' })).toHaveCount(0);
});

test('renders admin workspace, manages users, and activates a rulepack version', async ({ page }) => {
  await setAuthenticatedSession(page, {
    user: {
      id: 'user-admin-001',
      email: 'admin@hospital.org',
      displayName: 'E2E Admin',
      role: 'admin',
    },
  });

  const users: Array<{
    id: string;
    tenantId: string;
    facilityId: string;
    email: string;
    displayName: string;
    role: string;
    isActive: boolean;
    mustChangePassword: boolean;
    lastLoginAt: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      id: 'user-admin-001',
      tenantId: 'tenant-001',
      facilityId: 'facility-001',
      email: 'admin@hospital.org',
      displayName: 'E2E Admin',
      role: 'admin',
      isActive: true,
      mustChangePassword: false,
      lastLoginAt: '2026-03-09T09:00:00.000Z',
      createdAt: '2026-03-09T08:00:00.000Z',
      updatedAt: '2026-03-09T08:00:00.000Z',
    },
  ];

  await page.route('**/v1/audit-trail**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk([
        {
          id: 'trail-001',
          claimId: 'clm-admin-001',
          userId: 'user-admin-001',
          action: 'RULEPACK_ACTIVATED',
          fromState: null,
          toState: null,
          detail: {
            version: '0.9.0',
            checksum: 'old-checksum',
          },
          ipAddress: '127.0.0.1',
          userAgent: 'Playwright',
          createdAt: '2026-03-09T08:00:00.000Z',
        },
      ]),
    });
  });

  await page.route('**/v1/admin/users/*/reset-password', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        userId: 'user-admin-001',
        mustChangePassword: true,
      }),
    });
  });

  await page.route('**/v1/admin/users/*', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }

    const requestUrl = new URL(route.request().url());
    const userId = requestUrl.pathname.split('/').at(-1);
    const body = route.request().postDataJSON() as { isActive?: boolean; role?: string };
    const target = users.find((item) => item.id === userId);

    if (target) {
      if (typeof body.isActive === 'boolean') {
        target.isActive = body.isActive;
      }

      if (typeof body.role === 'string') {
        target.role = body.role;
      }

      target.updatedAt = '2026-03-09T10:00:00.000Z';
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({ user: target }),
    });
  });

  await page.route('**/v1/admin/users**', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      const requestUrl = new URL(route.request().url());
      const includeInactive = requestUrl.searchParams.get('includeInactive') === 'true';
      const filteredUsers = includeInactive ? users : users.filter((item) => item.isActive);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: apiOk({ users: filteredUsers }),
      });
      return;
    }

    if (method === 'POST') {
      const payload = route.request().postDataJSON() as {
        email: string;
        displayName: string;
        role: string;
      };

      const createdUser = {
        id: `user-${users.length + 1}`,
        tenantId: 'tenant-001',
        facilityId: 'facility-001',
        email: payload.email.toLowerCase(),
        displayName: payload.displayName,
        role: payload.role,
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: null,
        createdAt: '2026-03-09T10:00:00.000Z',
        updatedAt: '2026-03-09T10:00:00.000Z',
      };

      users.push(createdUser);

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: apiOk({ user: createdUser }),
      });
      return;
    }

    await route.fallback();
  });

  await page.route('**/v1/admin/rulepacks/*/activate', async (route) => {
    const requestUrl = new URL(route.request().url());
    const match = requestUrl.pathname.match(/\/v1\/admin\/rulepacks\/([^/]+)\/activate$/);
    const version = decodeURIComponent(match?.[1] ?? 'unknown');

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        id: 'rp-001',
        version,
        checksum: 'abc123',
        activatedAt: '2026-03-09T08:30:00.000Z',
        activatedBy: 'user-admin-001',
      }),
    });
  });

  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByText('RULEPACK_ACTIVATED')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('cell', { name: 'admin@hospital.org', exact: true })).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await page.getByLabel(/^Email$/).fill('auditor@hospital.org');
  await page.getByLabel(/Display Name/i).fill('Auditor One');
  await page.getByLabel(/Temporary Password/i).fill('TempPass!5678');

  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/v1/admin/users') && request.method() === 'POST', {
      timeout: NAV_TIMEOUT_MS,
    }),
    page.getByRole('button', { name: 'Create User' }).click(),
  ]);

  await expect(page.getByText('User created successfully')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('cell', { name: 'auditor@hospital.org', exact: true })).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  const auditorRow = page.locator('tr', { has: page.getByRole('cell', { name: 'auditor@hospital.org', exact: true }) });

  await auditorRow.getByLabel('Role for auditor@hospital.org').selectOption('viewer');

  await Promise.all([
    page.waitForRequest((request) => {
      if (!request.url().includes('/v1/admin/users/') || request.method() !== 'PATCH') {
        return false;
      }

      const payload = request.postDataJSON() as { role?: string };
      return payload.role === 'viewer';
    }, {
      timeout: NAV_TIMEOUT_MS,
    }),
    auditorRow.getByRole('button', { name: 'Update Role' }).click(),
  ]);

  await expect(page.getByText('User updated successfully')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(auditorRow.getByRole('cell', { name: 'Viewer', exact: true })).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await auditorRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('User updated successfully')).toBeVisible({ timeout: NAV_TIMEOUT_MS });

  await page.getByLabel(/Rulepack Version/i).fill('1.0.0');

  await Promise.all([
    page.waitForRequest('**/v1/admin/rulepacks/1.0.0/activate', { timeout: NAV_TIMEOUT_MS }),
    page.getByRole('button', { name: 'Activate Rulepack' }).click(),
  ]);

  await expect(page.getByText('Activated rulepack 1.0.0', { exact: false })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByText('Checksum: abc123', { exact: false })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
});







