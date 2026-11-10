// Who is signed in: loaded once from /api/auth/me; a 401 anywhere signs the screen out.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, get, post, setUnauthorizedHandler, type Me } from './api.js';
import { useI18n } from './i18n.js';

interface Auth {
  me: Me | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(permission: string): boolean;
}

const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const { setLocale } = useI18n();

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    get<Me>('/api/auth/me')
      .then(setMe)
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      await post('/api/auth/login', { email, password });
      const m = await get<Me>('/api/auth/me');
      setLocale(m.user.locale);
      setMe(m);
    },
    [setLocale],
  );
  const logout = useCallback(async () => {
    await post('/api/auth/logout').catch(() => {});
    setMe(null);
  }, []);
  const can = useCallback((p: string) => me?.permissions.includes(p) ?? false, [me]);
  return <Ctx.Provider value={{ me, loading, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth(): Auth {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
