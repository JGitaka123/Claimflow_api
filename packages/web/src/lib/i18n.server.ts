import { cookies } from 'next/headers';
import { LOCALE_COOKIE_NAME, resolveLocale, type AppLocale } from '@/lib/i18n';

export function getLocaleFromCookie(): AppLocale {
  const cookieStore = cookies();
  const cookieValue = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
  return resolveLocale(cookieValue);
}