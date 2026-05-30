'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/contexts/auth-context';
import type { AppLocale } from '@/lib/i18n';

interface AppProvidersProps {
  children: ReactNode;
  locale: AppLocale;
  messages: AbstractIntlMessages;
  timeZone?: string;
}

export function AppProviders({ children, locale, messages, timeZone = 'Africa/Nairobi' }: AppProvidersProps): JSX.Element {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-cf-hydrated', 'true');

    return () => {
      document.documentElement.removeAttribute('data-cf-hydrated');
    };
  }, []);

  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

