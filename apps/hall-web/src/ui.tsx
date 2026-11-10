// Screen building blocks in the Farad look (the design system's tokens; app.css for the classes).
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from './api.js';
import { useI18n } from './i18n.js';

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled,
  onClick,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Card({ title, children, actions, className }: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {title || actions ? (
        <header className="card-head">
          {title ? <h2 className="label">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'err' | 'volt' | 'off';

/** A status dot with its label (never colour alone). */
export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`status status-${tone}`} data-tone={tone}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Stat({ label, value, tone, sub, small }: { label: string; value: ReactNode; tone?: Tone; sub?: ReactNode; small?: boolean }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`stat-value ${small ? 'small' : ''} ${tone ? `tone-${tone}` : ''}`} data-testid={`stat-${label}`}>
        {value}
      </span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

export function PageHead({ label, title, actions }: { label: string; title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <div className="label">{label}</div>
        <h1 className="page-title">{title}</h1>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="label">{title}</span>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const message = error instanceof ApiError ? `${error.message}${error.body['hint'] ? ` · ${String(error.body['hint'])}` : ''}` : String(error);
  return (
    <div role="alert" className="error-box">
      <strong>{t('app.error')}</strong>
      <span>{message}</span>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('app.retry')}
        </Button>
      ) : null}
    </div>
  );
}

/** A dialog over the page (Escape closes it). */
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2 className="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A form that submits once at a time and shows the API's error. */
export function Form({ onSubmit, children, actions }: { onSubmit: () => Promise<void>; children: ReactNode; actions: (busy: boolean) => ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const issues = error instanceof ApiError ? (error.body['issues'] as { path: string; message: string }[] | undefined) : undefined;
  return (
    <form onSubmit={submit} className="form">
      {children}
      {error ? (
        <div role="alert" className="form-error">
          {issues?.length ? issues.map((i) => <div key={i.path}>{`${i.path}: ${i.message}`}</div>) : error instanceof ApiError ? error.message : String(error)}
        </div>
      ) : null}
      <div className="form-actions">{actions(busy)}</div>
    </form>
  );
}

/** Loads with `load`, again every `everyMs` (0: once), and on reload(). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], everyMs = 0): { data: T | undefined; error: unknown; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    load()
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    if (!everyMs) return;
    const t = setInterval(reload, everyMs);
    return () => clearInterval(t);
  }, [everyMs, reload]);
  return { data, error, reload };
}

/** A key–value list (identity, network). */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="label">{k}</dt>
          <dd className="mono">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
