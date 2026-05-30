'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SUPPORTED_LOCALES, type AppLocale, getLocaleFromDocumentCookie, setLocaleCookie } from '@/lib/i18n';

export function LocaleSwitcher(): JSX.Element {
  const t = useTranslations('locale');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const activeLocale = getLocaleFromDocumentCookie();

  function handleSwitch(locale: AppLocale): void {
    if (locale === activeLocale) {
      return;
    }

    setLocaleCookie(locale);

    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/85 px-3 py-1 text-xs">
      <span className="text-[var(--muted)]">{t('label')}:</span>
      {SUPPORTED_LOCALES.map((locale) => {
        const isActive = locale === activeLocale;

        return (
          <button
            key={locale}
            type="button"
            onClick={() => handleSwitch(locale)}
            disabled={isPending}
            className={[
              'rounded-full px-2 py-0.5 font-semibold transition-colors',
              isActive ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:bg-[var(--soft)]',
            ].join(' ')}
            aria-pressed={isActive}
          >
            {t(locale)}
          </button>
        );
      })}
    </div>
  );
}