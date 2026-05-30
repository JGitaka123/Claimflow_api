'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiClient, ApiClientError } from '@/lib/api-client';

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface LoginStepResult {
  requiresMfa: boolean;
  mfaToken?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginStepResult>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function setCookie(name: string, value: string, maxAgeSeconds: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

function persistAccessToken(token: string): void {
  window.localStorage.setItem('cf_access_token', token);
  setCookie('cf_access_token', token, 15 * 60);
}

function clearAccessToken(): void {
  window.localStorage.removeItem('cf_access_token');
  clearCookie('cf_access_token');
}

function persistRefreshToken(token: string): void {
  window.localStorage.setItem('cf_refresh_token', token);
  setCookie('cf_refresh_token', token, 7 * 24 * 60 * 60);
}

function clearRefreshToken(): void {
  window.localStorage.removeItem('cf_refresh_token');
  clearCookie('cf_refresh_token');
}

function readStorage(key: string): string | null {
  const value = window.localStorage.getItem(key);
  return value && value.length > 0 ? value : null;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isCancelled = false;

    async function bootstrap(): Promise<void> {
      const initialToken = readStorage('cf_access_token');
      setAccessToken(initialToken);

      if (!initialToken) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await apiClient.get<{ user: AuthUser }>('/v1/auth/me', {
          token: initialToken,
        });

        if (!isCancelled) {
          setUser(response.data.user);
        }
      } catch (error) {
        if (!isCancelled && error instanceof ApiClientError && error.status === 401) {
          clearAccessToken();
          clearRefreshToken();
          setAccessToken(null);
          setUser(null);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      isCancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginStepResult> => {
    const response = await apiClient.post<{
      requiresMfa?: boolean;
      mfaToken?: string;
      user?: AuthUser;
      accessToken?: string;
      refreshToken?: string;
    }>('/v1/auth/login', {
      body: { email, password },
      token: null,
    });

    const data = response.data;

    if (data.accessToken && data.refreshToken && data.user) {
      persistAccessToken(data.accessToken);
      persistRefreshToken(data.refreshToken);
      setAccessToken(data.accessToken);
      setUser(data.user);
      return { requiresMfa: false };
    }

    return {
      requiresMfa: data.requiresMfa ?? true,
      mfaToken: data.mfaToken,
    };
  }, []);

  const verifyMfa = useCallback(async (mfaToken: string, code: string): Promise<void> => {
    const response = await apiClient.post<{
      accessToken: string;
      refreshToken: string;
      user: AuthUser;
    }>('/v1/auth/mfa/verify', {
      body: { mfaToken, code },
      token: null,
    });

    persistAccessToken(response.data.accessToken);
    persistRefreshToken(response.data.refreshToken);
    setAccessToken(response.data.accessToken);
    setUser(response.data.user);
  }, []);

  const refreshSession = useCallback(async (): Promise<void> => {
    const refreshToken = readStorage('cf_refresh_token');

    if (!refreshToken) {
      throw new ApiClientError({
        message: 'Missing refresh token',
        status: 401,
      });
    }

    const response = await apiClient.post<{
      accessToken: string;
      refreshToken: string;
      user: AuthUser;
    }>('/v1/auth/refresh', {
      body: { refreshToken },
      token: null,
    });

    persistAccessToken(response.data.accessToken);
    persistRefreshToken(response.data.refreshToken);
    setAccessToken(response.data.accessToken);
    setUser(response.data.user);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      const refreshToken = readStorage('cf_refresh_token');

      if (refreshToken) {
        await apiClient.post('/v1/auth/logout', {
          body: { refreshToken },
          token: null,
        });
      }
    } catch {
      // best effort logout
    }

    clearAccessToken();
    clearRefreshToken();
    setAccessToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      isAuthenticated: Boolean(accessToken),
      isLoading,
      login,
      verifyMfa,
      refreshSession,
      logout,
    }),
    [accessToken, isLoading, login, logout, refreshSession, user, verifyMfa],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
}

