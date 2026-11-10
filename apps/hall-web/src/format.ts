// Numbers, times and durations as the screens show them.
import { translate, type Key, type Locale } from './i18n.js';

export function ago(iso: string | null, locale: Locale, now = Date.now()): string {
  const t = (k: Key, n?: number) => translate(locale, k, n === undefined ? {} : { n });
  if (!iso) return t('time.never');
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return t('time.now');
  if (s < 60) return t('time.s', s);
  if (s < 3600) return t('time.min', Math.floor(s / 60));
  if (s < 86_400) return t('time.h', Math.floor(s / 3600));
  return t('time.d', Math.floor(s / 86_400));
}

export function dateTime(iso: string | null, locale: Locale): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

export function time(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** 93784 → 1 d 2 h · 5400 → 1 h 30 min */
export function duration(s: number | null): string {
  if (s === null) return '—';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export const pct = (v: number | null | undefined, locale: Locale) => (v === null || v === undefined ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v));

/** 11222333000181 → 11.222.333/0001-81; 52998224725 → 529.982.247-25 */
export function taxId(doc: string): string {
  if (doc.length === 14) return `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5, 8)}/${doc.slice(8, 12)}-${doc.slice(12)}`;
  if (doc.length === 11) return `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9)}`;
  return doc;
}
