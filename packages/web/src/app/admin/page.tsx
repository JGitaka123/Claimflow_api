'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageHeader } from '@/components/ui/PageHeader';
import { ApiClientError, apiClient } from '@/lib/api-client';
import { useAuth } from '@/contexts/auth-context';

interface AuditTrailEntry {
  id: string;
  claimId: string | null;
  userId: string | null;
  action: string;
  fromState: string | null;
  toState: string | null;
  detail: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface ActivatedRulepack {
  id: string;
  version: string;
  checksum: string;
  activatedAt: string;
  activatedBy: string;
}

interface AdminUser {
  id: string;
  tenantId: string;
  facilityId: string | null;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreateUserPayload {
  email: string;
  displayName: string;
  role: string;
  temporaryPassword: string;
}

interface UpdateUserPayload {
  userId: string;
  isActive?: boolean;
  role?: string;
}

interface ResetPasswordPayload {
  userId: string;
  temporaryPassword: string;
}

const LIMIT_OPTIONS = [20, 50, 100, 200];
const USER_ROLE_OPTIONS = [
  'claims_officer',
  'auditor',
  'supervisor',
  'admin',
  'super_admin',
  'viewer',
] as const;

function formatDateTime(value: string, locale: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDetail(detail: Record<string, unknown>): string {
  const keys = Object.keys(detail);

  if (keys.length === 0) {
    return '-';
  }

  const preview = keys.slice(0, 2).map((key) => `${key}=${String(detail[key])}`);
  return preview.join(', ');
}

function formatRoleLabel(role: string): string {
  return role.replace(/_/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export default function AdminPage(): JSX.Element {
  const t = useTranslations('adminPage');
  const locale = useLocale().startsWith('sw') ? 'sw-KE' : 'en-KE';
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user, isLoading } = useAuth();

  const normalizedRole = (user?.role ?? '').toLowerCase();
  const isAdmin = normalizedRole === 'admin' || normalizedRole === 'super_admin';
  const canManageSuperAdmin = normalizedRole === 'super_admin';

  useEffect(() => {
    if (!isLoading && !isAdmin) {
      router.replace('/dashboard');
    }
  }, [isAdmin, isLoading, router]);

  const [limit, setLimit] = useState(50);
  const [versionInput, setVersionInput] = useState('');
  const [activationResult, setActivationResult] = useState<ActivatedRulepack | null>(null);
  const [activationError, setActivationError] = useState<string | null>(null);

  const [includeInactiveUsers, setIncludeInactiveUsers] = useState(false);
  const [roleSelections, setRoleSelections] = useState<Record<string, string>>({});
  const [userActionError, setUserActionError] = useState<string | null>(null);
  const [userActionNotice, setUserActionNotice] = useState<string | null>(null);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserDisplayName, setNewUserDisplayName] = useState('');
  const [newUserRole, setNewUserRole] = useState<string>('claims_officer');
  const [newUserTemporaryPassword, setNewUserTemporaryPassword] = useState('TempPass!1234');

  const auditTrailQuery = useQuery({
    queryKey: ['admin', 'audit-trail', limit],
    enabled: isAdmin,
    queryFn: async () => {
      const response = await apiClient.get<AuditTrailEntry[]>(`/v1/audit-trail?limit=${limit}`);
      return response.data;
    },
  });

  const usersQuery = useQuery({
    queryKey: ['admin', 'users', includeInactiveUsers],
    enabled: isAdmin,
    queryFn: async () => {
      const response = await apiClient.get<{ users: AdminUser[] }>(
        `/v1/admin/users?includeInactive=${includeInactiveUsers}`,
      );

      return response.data.users;
    },
  });

  const activateRulepackMutation = useMutation({
    mutationFn: async (version: string) => {
      const encodedVersion = encodeURIComponent(version);
      const response = await apiClient.post<ActivatedRulepack>(`/v1/admin/rulepacks/${encodedVersion}/activate`);
      return response.data;
    },
    onSuccess: async (data) => {
      setActivationError(null);
      setActivationResult(data);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'audit-trail'] });
    },
    onError: (error) => {
      setActivationResult(null);
      setActivationError(getErrorMessage(error, t('activateFailed')));
    },
  });

  const createUserMutation = useMutation({
    mutationFn: async (payload: CreateUserPayload) => {
      const response = await apiClient.post<{ user: AdminUser }>('/v1/admin/users', {
        body: payload,
      });

      return response.data.user;
    },
    onSuccess: async () => {
      setUserActionError(null);
      setUserActionNotice(t('usersCreated'));
      setNewUserEmail('');
      setNewUserDisplayName('');
      setNewUserRole('claims_officer');
      setNewUserTemporaryPassword('TempPass!1234');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'audit-trail'] });
    },
    onError: (error) => {
      setUserActionNotice(null);
      setUserActionError(getErrorMessage(error, t('usersActionFailed')));
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: async (payload: UpdateUserPayload) => {
      const response = await apiClient.patch<{ user: AdminUser }>(`/v1/admin/users/${payload.userId}`, {
        body: {
          isActive: payload.isActive,
          role: payload.role,
        },
      });

      return response.data.user;
    },
    onSuccess: async () => {
      setUserActionError(null);
      setUserActionNotice(t('usersUpdated'));
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'audit-trail'] });
    },
    onError: (error) => {
      setUserActionNotice(null);
      setUserActionError(getErrorMessage(error, t('usersActionFailed')));
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (payload: ResetPasswordPayload) => {
      const response = await apiClient.post<{ userId: string; mustChangePassword: boolean }>(
        `/v1/admin/users/${payload.userId}/reset-password`,
        {
          body: {
            temporaryPassword: payload.temporaryPassword,
          },
        },
      );

      return response.data;
    },
    onSuccess: async () => {
      setUserActionError(null);
      setUserActionNotice(t('usersReset'));
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'audit-trail'] });
    },
    onError: (error) => {
      setUserActionNotice(null);
      setUserActionError(getErrorMessage(error, t('usersActionFailed')));
    },
  });
  const assignableRoleOptions = useMemo(
    () => USER_ROLE_OPTIONS.filter((role) => canManageSuperAdmin || role !== 'super_admin'),
    [canManageSuperAdmin],
  );

  useEffect(() => {
    if (!usersQuery.data) {
      return;
    }

    setRoleSelections((previous) => {
      const nextSelections: Record<string, string> = {};

      for (const adminUser of usersQuery.data) {
        nextSelections[adminUser.id] = previous[adminUser.id] ?? adminUser.role;
      }

      return nextSelections;
    });
  }, [usersQuery.data]);
  const auditColumns = useMemo<Array<DataTableColumn<AuditTrailEntry>>>(
    () => [
      {
        key: 'createdAt',
        header: t('table.time'),
        render: (row) => formatDateTime(row.createdAt, locale),
      },
      {
        key: 'action',
        header: t('table.action'),
        render: (row) => row.action,
      },
      {
        key: 'claimId',
        header: t('table.claimId'),
        render: (row) => row.claimId ?? '-',
      },
      {
        key: 'transition',
        header: t('table.transition'),
        render: (row) => {
          if (!row.fromState && !row.toState) {
            return '-';
          }

          return `${row.fromState ?? '-'} -> ${row.toState ?? '-'}`;
        },
      },
      {
        key: 'userId',
        header: t('table.userId'),
        render: (row) => row.userId ?? '-',
      },
      {
        key: 'detail',
        header: t('table.detail'),
        render: (row) => (
          <span title={JSON.stringify(row.detail)}>
            {formatDetail(row.detail)}
          </span>
        ),
      },
    ],
    [locale, t],
  );

  const userColumns = useMemo<Array<DataTableColumn<AdminUser>>>(
    () => [
      {
        key: 'email',
        header: t('usersColumns.email'),
        render: (row) => row.email,
      },
      {
        key: 'displayName',
        header: t('usersColumns.displayName'),
        render: (row) => row.displayName,
      },
      {
        key: 'role',
        header: t('usersColumns.role'),
        render: (row) => formatRoleLabel(row.role),
      },
      {
        key: 'status',
        header: t('usersColumns.status'),
        render: (row) => (
          <span className={row.isActive ? 'text-emerald-700' : 'text-amber-700'}>
            {row.isActive ? t('usersActive') : t('usersInactive')}
          </span>
        ),
      },
      {
        key: 'lastLoginAt',
        header: t('usersColumns.lastLogin'),
        render: (row) => (row.lastLoginAt ? formatDateTime(row.lastLoginAt, locale) : '-'),
      },
      {
        key: 'actions',
        header: t('usersColumns.actions'),
        render: (row) => {
          const selectedRole = roleSelections[row.id] ?? row.role;
          const roleUpdateLocked = row.role === 'super_admin' && !canManageSuperAdmin;

          return (
            <div className="flex flex-wrap items-center gap-2">
              {roleUpdateLocked ? (
                <span className="rounded-lg border border-[var(--line)] bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                  {t('usersRoleLocked')}
                </span>
              ) : (
                <>
                  <label htmlFor={`role-${row.id}`} className="sr-only">
                    {t('usersRoleSelectAria', { email: row.email })}
                  </label>
                  <select
                    id={`role-${row.id}`}
                    value={selectedRole}
                    onChange={(event) => {
                      const nextRole = event.target.value;
                      setRoleSelections((previous) => ({
                        ...previous,
                        [row.id]: nextRole,
                      }));
                    }}
                    className="rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-xs"
                    aria-label={t('usersRoleSelectAria', { email: row.email })}
                    disabled={updateUserMutation.isPending}
                  >
                    {assignableRoleOptions.map((roleOption) => (
                      <option key={roleOption} value={roleOption}>
                        {formatRoleLabel(roleOption)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--line)] bg-white px-2.5 py-1 text-xs font-medium"
                    onClick={() => {
                      if (selectedRole === row.role) {
                        return;
                      }

                      setUserActionNotice(null);
                      void updateUserMutation.mutateAsync({
                        userId: row.id,
                        role: selectedRole,
                      });
                    }}
                    disabled={updateUserMutation.isPending || selectedRole === row.role}
                  >
                    {t('usersUpdateRole')}
                  </button>
                </>
              )}

              <button
                type="button"
                className="rounded-lg border border-[var(--line)] bg-white px-2.5 py-1 text-xs font-medium"
                onClick={() => {
                  setUserActionNotice(null);
                  void updateUserMutation.mutateAsync({
                    userId: row.id,
                    isActive: !row.isActive,
                  });
                }}
                disabled={updateUserMutation.isPending || roleUpdateLocked}
              >
                {row.isActive ? t('usersDeactivate') : t('usersActivate')}
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--line)] bg-white px-2.5 py-1 text-xs font-medium"
                onClick={() => {
                  const temporaryPassword = window.prompt(t('usersPasswordPrompt'), 'TempPass!1234');

                  if (!temporaryPassword || temporaryPassword.trim().length < 12) {
                    return;
                  }

                  setUserActionNotice(null);
                  void resetPasswordMutation.mutateAsync({
                    userId: row.id,
                    temporaryPassword: temporaryPassword.trim(),
                  });
                }}
                disabled={resetPasswordMutation.isPending || roleUpdateLocked}
              >
                {t('usersResetPassword')}
              </button>
            </div>
          );
        },
      },
    ],
    [
      assignableRoleOptions,
      canManageSuperAdmin,
      locale,
      resetPasswordMutation,
      roleSelections,
      t,
      updateUserMutation,
    ],
  );
  const auditTrailRows = auditTrailQuery.data ?? [];
  const auditTrailErrorMessage = auditTrailQuery.isError
    ? getErrorMessage(auditTrailQuery.error, t('loadFailed'))
    : null;

  const usersRows = usersQuery.data ?? [];
  const usersErrorMessage = usersQuery.isError
    ? getErrorMessage(usersQuery.error, t('usersLoadFailed'))
    : null;

  async function handleActivateRulepack(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const version = versionInput.trim();
    if (version.length === 0) {
      return;
    }

    setActivationError(null);
    await activateRulepackMutation.mutateAsync(version);
  }

  async function handleCreateUser(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (
      newUserEmail.trim().length === 0 ||
      newUserDisplayName.trim().length === 0 ||
      newUserTemporaryPassword.trim().length < 12
    ) {
      return;
    }

    setUserActionError(null);
    setUserActionNotice(null);

    await createUserMutation.mutateAsync({
      email: newUserEmail.trim(),
      displayName: newUserDisplayName.trim(),
      role: newUserRole,
      temporaryPassword: newUserTemporaryPassword.trim(),
    });
  }

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-10">
        <LoadingSpinner label={t('authorizing')} />
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-10">
        <LoadingSpinner label={t('redirecting')} />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={[{ label: t('dashboardCrumb'), href: '/dashboard' }, { label: t('title') }]}
      />

      <section className="mb-5 grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <article className="glass-card p-5">
          <h2 className="font-[var(--font-heading)] text-lg font-semibold text-[var(--ink)]">{t('activateTitle')}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('activateSubtitle')}</p>

          <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={handleActivateRulepack}>
            <label className="flex-1 text-sm">
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('versionLabel')}</span>
              <input
                value={versionInput}
                onChange={(event) => setVersionInput(event.target.value)}
                placeholder={t('versionPlaceholder')}
                className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              />
            </label>

            <button
              type="submit"
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={activateRulepackMutation.isPending || versionInput.trim().length === 0}
            >
              {activateRulepackMutation.isPending ? (
                <LoadingSpinner label={t('activating')} size="sm" />
              ) : (
                t('activate')
              )}
            </button>
          </form>

          {activationError ? <p className="mt-3 text-sm text-[var(--danger)]">{activationError}</p> : null}

          {activationResult ? (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <p>
                {t('activationSuccess', {
                  version: activationResult.version,
                  activatedAt: formatDateTime(activationResult.activatedAt, locale),
                })}
              </p>
              <p className="mt-1 text-xs">
                {t('activationMeta', {
                  checksum: activationResult.checksum,
                  activatedBy: activationResult.activatedBy,
                })}
              </p>
            </div>
          ) : null}
        </article>

        <article className="glass-card p-5">
          <h2 className="font-[var(--font-heading)] text-lg font-semibold text-[var(--ink)]">{t('usersTitle')}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('usersSubtitle')}</p>

          <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={handleCreateUser}>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('usersEmail')}</span>
              <input
                required
                type="email"
                value={newUserEmail}
                onChange={(event) => setNewUserEmail(event.target.value)}
                className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              />
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('usersDisplayName')}</span>
              <input
                required
                value={newUserDisplayName}
                onChange={(event) => setNewUserDisplayName(event.target.value)}
                className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              />
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('usersRole')}</span>
              <select
                value={newUserRole}
                onChange={(event) => setNewUserRole(event.target.value)}
                className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                {USER_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {formatRoleLabel(role)}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('usersTemporaryPassword')}</span>
              <input
                required
                minLength={12}
                type="text"
                value={newUserTemporaryPassword}
                onChange={(event) => setNewUserTemporaryPassword(event.target.value)}
                className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              />
            </label>

            <div className="md:col-span-2">
              <button
                type="submit"
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={createUserMutation.isPending}
              >
                {createUserMutation.isPending ? t('usersCreating') : t('usersCreate')}
              </button>
            </div>
          </form>

          {userActionError ? <p className="mt-3 text-sm text-[var(--danger)]">{userActionError}</p> : null}
          {userActionNotice ? <p className="mt-3 text-sm text-emerald-700">{userActionNotice}</p> : null}
        </article>
      </section>

      <section className="mb-5 glass-card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-[var(--font-heading)] text-lg font-semibold text-[var(--ink)]">{t('usersTitle')}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{t('usersSubtitle')}</p>
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              checked={includeInactiveUsers}
              onChange={(event) => setIncludeInactiveUsers(event.target.checked)}
            />
            {t('usersIncludeInactive')}
          </label>
        </div>

        {usersQuery.isLoading ? (
          <LoadingSpinner label={t('usersLoading')} />
        ) : usersErrorMessage ? (
          <p className="text-sm text-[var(--danger)]">{usersErrorMessage}</p>
        ) : (
          <DataTable
            columns={userColumns}
            rows={usersRows}
            getRowKey={(row) => row.id}
            emptyMessage={t('usersEmpty')}
          />
        )}
      </section>

      <section className="glass-card p-5">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <h2 className="font-[var(--font-heading)] text-lg font-semibold text-[var(--ink)]">{t('trailTitle')}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{t('trailSubtitle')}</p>
          </div>

          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-[0.08em] text-[var(--muted)]">{t('limitLabel')}</span>
            <select
              className="rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium"
            onClick={() => auditTrailQuery.refetch()}
            disabled={auditTrailQuery.isFetching}
          >
            {auditTrailQuery.isFetching ? t('refreshing') : t('refresh')}
          </button>
        </div>

        {auditTrailQuery.isLoading ? (
          <LoadingSpinner label={t('loadingTrail')} />
        ) : auditTrailErrorMessage ? (
          <p className="text-sm text-[var(--danger)]">{auditTrailErrorMessage}</p>
        ) : (
          <DataTable
            columns={auditColumns}
            rows={auditTrailRows}
            getRowKey={(row) => row.id}
            emptyMessage={t('noTrail')}
          />
        )}
      </section>
    </main>
  );
}





