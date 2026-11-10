import { useState } from 'react';
import { ApiError } from '../api.js';
import { useAuth } from '../auth.js';
import { Lockup } from '../brand.js';
import { useI18n } from '../i18n.js';
import { Button, Field } from '../ui.js';

export function LoginPage() {
  const { login } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError(t('login.locked', { s: Number(err.body['retryAfterS'] ?? 60) }));
      else if (err instanceof ApiError && err.status === 401) setError(t('login.wrong'));
      else setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <Lockup size="lg" />
        <div>
          <h1 className="page-title">{t('login.title')}</h1>
          <p className="muted" style={{ marginTop: 'var(--sp-1)' }}>{t('login.subtitle')}</p>
        </div>
        <Field label={t('login.email')}>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('login.password')}>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? <div role="alert" className="form-error">{error}</div> : null}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>{t('login.submit')}</Button>
        </div>
        <div className="lang" role="group" aria-label={t('nav.language')}>
          {(['pt-BR', 'en'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={locale === l} onClick={() => setLocale(l)}>
              {l === 'pt-BR' ? 'PT' : 'EN'}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
