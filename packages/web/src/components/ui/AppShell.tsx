'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode } from 'react';
import clsx from 'clsx';
import { LocaleSwitcher } from '@/components/ui/LocaleSwitcher';
import { useAuth } from '@/contexts/auth-context';

interface AppShellProps {
  children: ReactNode;
}

function isAdminRole(role: string | null | undefined): boolean {
  const normalized = role?.toLowerCase();
  return normalized === 'admin' || normalized === 'super_admin';
}

function isAuthPage(pathname: string): boolean {
  return pathname.startsWith('/login');
}

export function AppShell({ children }: AppShellProps): JSX.Element {
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const tApp = useTranslations('app');
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAuthenticated, logout } = useAuth();

  if (isAuthPage(pathname)) {
    return <>{children}</>;
  }

  const canAccessAdmin = isAdminRole(user?.role);

  const navItems = [
    { href: '/dashboard', label: tNav('dashboard') },
    { href: '/claims', label: tNav('claims') },
    ...(canAccessAdmin ? [{ href: '/admin', label: tNav('admin') }] : []),
  ];

  async function handleLogout(): Promise<void> {
    await logout();
    router.push('/login');
  }

  return (
    <>
      <header className="mx-auto w-full max-w-[1400px] px-4 pt-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--soft)]/90 px-4 py-3 shadow-card">
          <div className="flex items-center gap-4">
            <p className="font-[var(--font-heading)] text-lg font-semibold text-[var(--ink)]">{tApp('name')}</p>
            <nav className="flex flex-wrap items-center gap-2">
              {navItems.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={clsx(
                      'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-[var(--accent)] text-white'
                        : 'text-[var(--ink)] hover:bg-white',
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {isAuthenticated ? (
              <span className="hidden rounded-lg border border-[var(--line)] bg-white px-2.5 py-1 text-xs text-[var(--muted)] md:inline-flex">
                {tCommon('signedInAs', { name: user?.displayName ?? tApp('name') })}
              </span>
            ) : null}
            <LocaleSwitcher />
            {isAuthenticated ? (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--soft)]"
              >
                {tCommon('logout')}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {children}
    </>
  );
}

