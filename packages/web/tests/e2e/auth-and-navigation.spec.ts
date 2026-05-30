import { expect, test } from '@playwright/test';
import { apiOk, mockDashboardApis, waitForHydration } from './helpers';

const NAV_TIMEOUT_MS = 25_000;

test('redirects unauthenticated users to login', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/, { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
});

test('logs in and navigates to dashboard', async ({ page }) => {
  await mockDashboardApis(page);

  await page.route('**/v1/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        requiresMfa: false,
        accessToken: 'e2e-access-token',
        refreshToken: 'e2e-refresh-token',
        user: {
          id: 'user-e2e',
          email: 'officer@hospital.org',
          displayName: 'E2E Officer',
          role: 'claims_officer',
        },
      }),
    });
  });

  await page.goto('/login?next=%2Fdashboard', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  await page.getByLabel(/Work Email/i).fill('officer@hospital.org');
  await page.getByLabel(/Password/i).fill('password123');

  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/v1/auth/login') &&
        response.status() === 200,
      { timeout: NAV_TIMEOUT_MS },
    ),
    page.getByRole('button', { name: 'Continue' }).click(),
  ]);

  await expect(page).toHaveURL('/dashboard', { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByText('Claims Today')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
});

test('refreshes expired token during bootstrap and still loads dashboard', async ({ page }) => {
  await mockDashboardApis(page);

  let authMeCalls = 0;

  await page.route('**/v1/auth/me', async (route) => {
    authMeCalls += 1;

    if (authMeCalls === 1) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          errors: [
            {
              code: 'UNAUTHORIZED',
              message: 'Access token expired',
            },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        user: {
          id: 'user-refresh',
          email: 'officer@hospital.org',
          displayName: 'Refreshed Officer',
          role: 'claims_officer',
        },
      }),
    });
  });

  await page.route('**/v1/auth/refresh', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: apiOk({
        accessToken: 'e2e-refreshed-access-token',
        refreshToken: 'e2e-refreshed-refresh-token',
        user: {
          id: 'user-refresh',
          email: 'officer@hospital.org',
          displayName: 'Refreshed Officer',
          role: 'claims_officer',
        },
      }),
    });
  });

  await page.context().addCookies([
    {
      name: 'cf_access_token',
      value: 'expired-access-token',
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Lax',
    },
  ]);

  await page.addInitScript(() => {
    window.localStorage.setItem('cf_access_token', 'expired-access-token');
    window.localStorage.setItem('cf_refresh_token', 'bootstrap-refresh-token');
    document.cookie = 'cf_access_token=expired-access-token; path=/; samesite=lax';
    document.cookie = 'cf_refresh_token=bootstrap-refresh-token; path=/; samesite=lax';
  });

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  await expect(page).toHaveURL('/dashboard', { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  await expect(page.getByText('Claims Today')).toBeVisible({ timeout: NAV_TIMEOUT_MS });
  expect(authMeCalls).toBeGreaterThanOrEqual(2);
});
