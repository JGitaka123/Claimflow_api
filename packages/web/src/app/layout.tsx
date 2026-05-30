import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Space_Grotesk } from 'next/font/google';
import { AppProviders } from './providers';
import { AppShell } from '@/components/ui/AppShell';
import { getMessages } from '@/lib/i18n';
import { getLocaleFromCookie } from '@/lib/i18n.server';
import './globals.css';

const headingFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',
  display: 'swap',
});

const bodyMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-body',
  weight: ['400', '500'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ClaimFlow',
  description: 'SHA claims documentation audit workspace',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  const locale = getLocaleFromCookie();
  const messages = getMessages(locale);

  return (
    <html lang={locale}>
      <body className={`${headingFont.variable} ${bodyMono.variable} app-shell font-[var(--font-body)] text-ink`}>
        <AppProviders locale={locale} messages={messages}>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}

