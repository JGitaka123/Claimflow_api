import type { AbstractIntlMessages } from 'next-intl';
import enMessages from '@/messages/en.json';
import swMessages from '@/messages/sw.json';

export const SUPPORTED_LOCALES = ['en', 'sw'] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export const LOCALE_COOKIE_NAME = 'cf_locale';

const DEFAULT_LOCALE: AppLocale = 'en';

export function resolveLocale(input?: string | null): AppLocale {
  if (!input) {
    return DEFAULT_LOCALE;
  }

  const normalized = input.toLowerCase().trim();
  return normalized.startsWith('sw') ? 'sw' : 'en';
}

export function getLocaleFromDocumentCookie(): AppLocale {
  if (typeof document === 'undefined') {
    return DEFAULT_LOCALE;
  }

  const cookie = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${LOCALE_COOKIE_NAME}=`));

  if (!cookie) {
    return DEFAULT_LOCALE;
  }

  return resolveLocale(decodeURIComponent(cookie.split('=').slice(1).join('=')));
}

export function setLocaleCookie(locale: AppLocale): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; path=/; max-age=${365 * 24 * 60 * 60}; samesite=lax`;
}

export function getMessages(locale: AppLocale): AbstractIntlMessages {
  return locale === 'sw' ? (swMessages as AbstractIntlMessages) : (enMessages as AbstractIntlMessages);
}