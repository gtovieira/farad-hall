// The web UI in jsdom: the words in both languages, the fleet table, the presence strip, sign-in.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevicePresence, FleetDevice } from '../src/api.js';
import { App } from '../src/App.js';
import { AuthProvider } from '../src/auth.js';
import { ago, taxId } from '../src/format.js';
import { DICTIONARIES, I18nProvider, translate, type Locale } from '../src/i18n.js';
import { PresenceStrip } from '../src/pages/Device.js';
import { FleetTable, matches } from '../src/pages/Fleet.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const device = (over: Partial<FleetDevice> = {}): FleetDevice => ({
  id: '0b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b',
  name: 'orquestra-aurora',
  status: 'active',
  presence: 'online',
  lastSeenAt: new Date(Date.now() - 20_000).toISOString(),
  version: 'v1.4.0',
  protocolVersion: 1,
  publicIp: '177.20.100.10',
  lanIp: '192.168.10.21',
  uptimeS: 5000,
  imageDigest: null,
  controlMode: 'normal',
  healthOk: true,
  site: { id: 's1', name: 'Edifício Aurora' },
  customer: { id: 'c1', name: 'Condomínio Edifício Aurora' },
  reseller: null,
  openAlerts: 0,
  criticalAlerts: 0,
  enrolledAt: new Date().toISOString(),
  ...over,
});

const inLocale = (locale: Locale, ui: React.ReactNode) => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

describe('words', () => {
  it('English has every Portuguese key, with the same placeholders', () => {
    const pt = DICTIONARIES['pt-BR'];
    const en = DICTIONARIES['en'];
    for (const key of Object.keys(pt) as (keyof typeof pt)[]) {
      expect(en[key], key).toBeTruthy();
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(vars(en[key]!), key).toBe(vars(pt[key]!));
    }
  });

  it('formats times, durations and tax ids', () => {
    expect(translate('pt-BR', 'time.min', { n: 3 })).toBe('há 3 min');
    expect(ago(new Date(Date.now() - 125_000).toISOString(), 'en')).toBe('2 min ago');
    expect(ago(null, 'pt-BR')).toBe('nunca');
    expect(taxId('11222333000181')).toBe('11.222.333/0001-81');
    expect(taxId('52998224725')).toBe('529.982.247-25');
  });
});

describe('fleet table', () => {
  it('shows presence, site, customer, version, public IP and alerts, in Portuguese', () => {
    inLocale('pt-BR', <FleetTable devices={[device(), device({ id: 'x', presence: 'offline', site: { id: 's2', name: 'Torre B' }, openAlerts: 2, criticalAlerts: 1, controlMode: 'fallback-analyzer' })]} />);
    expect(screen.getByText('Edifício Aurora')).toBeTruthy();
    expect(screen.getAllByText('177.20.100.10')).toHaveLength(2);
    expect(screen.getAllByText('On-line')[0]!.closest('[data-tone]')!.getAttribute('data-tone')).toBe('ok');
    expect(screen.getByText('Off-line').closest('[data-tone]')!.getAttribute('data-tone')).toBe('off');
    expect(screen.getByText('Fallback · medidor')).toBeTruthy();
    expect(screen.getByText((_, el) => el?.classList.contains('badge') === true && el.textContent === '2 · Crítico')).toBeTruthy();
    expect(screen.getAllByText('há 20 s')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'IP público' })).toBeTruthy();
  });

  it('and in English', () => {
    inLocale('en', <FleetTable devices={[device()]} />);
    expect(screen.getByRole('columnheader', { name: 'Public IP' })).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
  });

  it('searches every word across site, customer, IP and version', () => {
    expect(matches(device(), 'aurora 177.20')).toBe(true);
    expect(matches(device(), 'v1.4')).toBe(true);
    expect(matches(device(), 'aurora torre')).toBe(false);
  });
});

describe('presence strip', () => {
  it('marks each bucket full, partial or empty, with a legend', () => {
    const p: DevicePresence = {
      from: '2026-11-10T00:00:00.000Z',
      to: '2026-11-10T00:15:00.000Z',
      bucketS: 300,
      expectedPerBucket: 5,
      buckets: [
        { start: '2026-11-10T00:00:00.000Z', heartbeats: 5 },
        { start: '2026-11-10T00:05:00.000Z', heartbeats: 2 },
        { start: '2026-11-10T00:10:00.000Z', heartbeats: 0 },
      ],
    };
    const { container } = inLocale('pt-BR', <PresenceStrip presence={p} />);
    const bars = [...container.querySelectorAll('.presence-bars > span')].map((b) => b.className);
    expect(bars).toEqual(['full', 'partial', 'none']);
    expect(screen.getByText('todos os batimentos')).toBeTruthy();
    expect(screen.getByText('sem batimento')).toBeTruthy();
  });
});

describe('sign-in', () => {
  it('signs in and lands on the fleet', async () => {
    let signedIn = false;
    const me = { user: { id: 'u', email: 'admin@farad.test', name: 'Admin', locale: 'pt-BR', roles: [] }, permissions: ['fleet:read', 'org:read', 'devices:manage', 'alerts:read'] };
    const fleet = { generatedAt: new Date().toISOString(), onlineWindowS: 180, summary: { total: 1, online: 1, offline: 0, revoked: 0, withAlerts: 0, openAlerts: 0 }, devices: [device()] };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/auth/login') {
        const b = JSON.parse(String(init?.body));
        if (b.password !== 'right password') return json(401, { error: 'invalid-credentials', message: 'wrong' });
        signedIn = true;
        return json(200, { user: me.user, expiresAt: new Date().toISOString() });
      }
      if (url === '/api/auth/me') return signedIn ? json(200, me) : json(401, { error: 'unauthorized', message: 'sign in' });
      if (url === '/api/fleet') return json(200, fleet);
      return json(404, { error: 'not-found', message: url });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState(null, '', '/');
    render(
      <I18nProvider locale="pt-BR">
        <AuthProvider>
          <App />
        </AuthProvider>
      </I18nProvider>,
    );
    const email = await screen.findByLabelText('E-mail');
    fireEvent.change(email, { target: { value: 'admin@farad.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('E-mail ou senha incorretos')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'right password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Frota' })).toBeTruthy());
    expect(await screen.findByText('Edifício Aurora')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Códigos de vínculo' })).toBeTruthy();
  });
});
