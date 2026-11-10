// The frame: the sidebar (lockup, navigation, language, the person) and the page.
import type { ReactNode } from 'react';
import { patch } from './api.js';
import { useAuth } from './auth.js';
import { Lockup } from './brand.js';
import { useI18n, type Key, type Locale } from './i18n.js';
import { Link } from './router.js';

const NAV: { path: string; key: Key; perm: string }[] = [
  { path: '/', key: 'nav.fleet', perm: 'fleet:read' },
  { path: '/alerts', key: 'nav.alerts', perm: 'alerts:read' },
  { path: '/customers', key: 'nav.customers', perm: 'org:read' },
  { path: '/claim-codes', key: 'nav.claimCodes', perm: 'devices:manage' },
];

const isOn = (path: string, active: string) => (path === '/' ? active === '/' || active.startsWith('/devices') : active.startsWith(path));

export function Layout({ active, children }: { active: string; children: ReactNode }) {
  const { me, logout, can } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const choose = (l: Locale) => {
    setLocale(l);
    void patch('/api/auth/me', { locale: l }).catch(() => {});
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <Lockup />
        <nav className="nav" aria-label="Hall">
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <Link key={n.path} to={n.path} className={isOn(n.path, active) ? 'on' : ''}>
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="lang" role="group" aria-label={t('nav.language')}>
            {(['pt-BR', 'en'] as const).map((l) => (
              <button key={l} type="button" aria-pressed={locale === l} onClick={() => choose(l)}>
                {l === 'pt-BR' ? 'PT' : 'EN'}
              </button>
            ))}
          </div>
          <span className="who" title={me?.user.email}>
            {me?.user.name}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            {t('nav.signOut')}
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
