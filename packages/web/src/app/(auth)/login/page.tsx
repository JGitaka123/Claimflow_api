'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/auth-context';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

type Stage = 'password' | 'mfa';

export default function LoginPage(): JSX.Element {
  const tAuth = useTranslations('auth');
  const tApp = useTranslations('app');
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/dashboard';

  const { login, verifyMfa } = useAuth();

  const [stage, setStage] = useState<Stage>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const buttonLabel = useMemo(() => {
    if (isSubmitting) {
      return tAuth('loading');
    }

    return stage === 'password' ? tAuth('continue') : tAuth('verify');
  }, [isSubmitting, stage, tAuth]);

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await login(email, password);

      if (result.requiresMfa) {
        setMfaToken(result.mfaToken ?? '');
        setStage('mfa');
      } else {
        router.push(nextPath);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : tAuth('loginFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMfaSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await verifyMfa(mfaToken, mfaCode);
      router.push(nextPath);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : tAuth('mfaFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="glass-card w-full max-w-md p-8">
        <p className="text-xs uppercase tracking-[0.15em] text-[var(--muted)]">{tApp('name')}</p>
        <h1 className="mt-2 font-[var(--font-heading)] text-3xl font-semibold text-[var(--ink)]">{tAuth('title')}</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{tAuth('subtitle')}</p>

        {stage === 'password' ? (
          <form className="mt-6 space-y-4" onSubmit={handlePasswordSubmit}>
            <label className="block text-sm font-medium text-[var(--ink)]">
              {tAuth('email')}
              <input
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
                placeholder={tAuth('emailPlaceholder')}
              />
            </label>
            <label className="block text-sm font-medium text-[var(--ink)]">
              {tAuth('password')}
              <input
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
              />
            </label>

            {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
              disabled={isSubmitting}
            >
              {isSubmitting ? <LoadingSpinner label={buttonLabel} size="sm" /> : buttonLabel}
            </button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={handleMfaSubmit}>
            <label className="block text-sm font-medium text-[var(--ink)]">
              {tAuth('mfaCode')}
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
                placeholder={tAuth('mfaPlaceholder')}
              />
            </label>

            {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setStage('password')}
                className="inline-flex items-center justify-center rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium"
                disabled={isSubmitting}
              >
                {tAuth('back')}
              </button>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
                disabled={isSubmitting}
              >
                {isSubmitting ? <LoadingSpinner label={buttonLabel} size="sm" /> : buttonLabel}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}