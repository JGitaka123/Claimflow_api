import type { ApiResponse, ApiErrorResponse } from '@claimflow/shared';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly detail?: Record<string, unknown>;

  constructor(params: {
    message: string;
    status: number;
    code?: string;
    requestId?: string;
    detail?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.detail = params.detail;
  }
}

interface RequestOptions {
  body?: unknown | FormData;
  token?: string | null;
  headers?: HeadersInit;
}

interface RefreshPayload {
  accessToken: string;
  refreshToken: string;
}

const ACCESS_TOKEN_STORAGE_KEY = 'cf_access_token';
const REFRESH_TOKEN_STORAGE_KEY = 'cf_refresh_token';
const ACCESS_TOKEN_COOKIE_NAME = 'cf_access_token';
const REFRESH_TOKEN_COOKIE_NAME = 'cf_refresh_token';
const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

let refreshInFlight: Promise<RefreshPayload | null> | null = null;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const value = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));

  if (!value) {
    return null;
  }

  return decodeURIComponent(value.split('=').slice(1).join('='));
}

function getStoredToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const fromLocalStorage = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  if (fromLocalStorage && fromLocalStorage.length > 0) {
    return fromLocalStorage;
  }

  return readCookie(ACCESS_TOKEN_COOKIE_NAME);
}

function getStoredRefreshToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const fromLocalStorage = window.localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
  if (fromLocalStorage && fromLocalStorage.length > 0) {
    return fromLocalStorage;
  }

  return readCookie(REFRESH_TOKEN_COOKIE_NAME);
}

function setCookie(name: string, value: string, maxAgeSeconds: number): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

function clearCookie(name: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

function persistAuthTokens(tokens: RefreshPayload): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, tokens.accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, tokens.refreshToken);
  }

  setCookie(ACCESS_TOKEN_COOKIE_NAME, tokens.accessToken, ACCESS_TOKEN_MAX_AGE_SECONDS);
  setCookie(REFRESH_TOKEN_COOKIE_NAME, tokens.refreshToken, REFRESH_TOKEN_MAX_AGE_SECONDS);
}

function clearAuthTokens(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  }

  clearCookie(ACCESS_TOKEN_COOKIE_NAME);
  clearCookie(REFRESH_TOKEN_COOKIE_NAME);
}

function getRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `req-${Date.now()}`;
}

function resolveBaseUrl(): string {
  const envValue = process.env.NEXT_PUBLIC_API_BASE_URL;
  return envValue && envValue.length > 0 ? envValue : 'http://localhost:8080';
}

function resolveAcceptLanguage(): string {
  const locale = readCookie('cf_locale');

  if (!locale) {
    return 'en';
  }

  return locale.toLowerCase().startsWith('sw') ? 'sw' : 'en';
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = resolveBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async get<T>(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  async post<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, options);
  }

  async patch<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, options);
  }

  private isRefreshEligible(path: string): boolean {
    const normalizedPath = path.split('?')[0];
    return !(
      normalizedPath === '/v1/auth/login' ||
      normalizedPath === '/v1/auth/mfa/verify' ||
      normalizedPath === '/v1/auth/refresh' ||
      normalizedPath === '/v1/auth/logout'
    );
  }

  private async executeRequest(
    method: string,
    path: string,
    headers: Headers,
    body: BodyInit | undefined,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
      credentials: 'include',
      cache: 'no-store',
    });
  }

  private async refreshAccessToken(): Promise<RefreshPayload | null> {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) {
        clearAuthTokens();
        return null;
      }

      const headers = new Headers();
      headers.set('content-type', 'application/json');
      headers.set('accept-language', resolveAcceptLanguage());
      headers.set('x-request-id', getRequestId());

      try {
        const response = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ refreshToken }),
          credentials: 'include',
          cache: 'no-store',
        });

        if (!response.ok) {
          clearAuthTokens();
          return null;
        }

        const payload = (await response.json()) as ApiResponse<RefreshPayload>;
        const tokens = payload.data;

        if (!tokens?.accessToken || !tokens?.refreshToken) {
          clearAuthTokens();
          return null;
        }

        persistAuthTokens(tokens);
        return tokens;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<ApiResponse<T>> {
    const token = options.token ?? getStoredToken();
    const requestId = getRequestId();

    const headers = new Headers(options.headers ?? {});
    headers.set('x-request-id', requestId);
    headers.set('accept-language', resolveAcceptLanguage());

    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }

    const hasBody = options.body !== undefined;
    const isFormDataBody =
      hasBody &&
      typeof FormData !== 'undefined' &&
      options.body instanceof FormData;

    if (hasBody && !isFormDataBody) {
      headers.set('content-type', 'application/json');
    }

    const requestBody: BodyInit | undefined = hasBody
      ? (isFormDataBody ? (options.body as FormData) : JSON.stringify(options.body))
      : undefined;

    let response = await this.executeRequest(method, path, headers, requestBody);

    if (response.status === 401 && token && this.isRefreshEligible(path)) {
      const refreshedTokens = await this.refreshAccessToken();
      if (refreshedTokens?.accessToken) {
        headers.set('authorization', `Bearer ${refreshedTokens.accessToken}`);
        response = await this.executeRequest(method, path, headers, requestBody);
      }
    }

    if (response.ok) {
      return (await response.json()) as ApiResponse<T>;
    }

    let errorPayload: ApiErrorResponse | null = null;

    try {
      errorPayload = (await response.json()) as ApiErrorResponse;
    } catch {
      errorPayload = null;
    }

    const firstError = errorPayload?.errors?.[0];

    throw new ApiClientError({
      message: firstError?.message ?? `Request failed with status ${response.status}`,
      status: response.status,
      code: firstError?.code,
      requestId: errorPayload?.meta?.requestId,
      detail: firstError?.detail,
    });
  }
}

export const apiClient = new ApiClient();

