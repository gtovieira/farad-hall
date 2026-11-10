// hall-api serving the web UI (HALL_WEB_DIR): files, client-side routes, and the API untouched.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startHall, type TestHall } from './helpers.js';

let t: TestHall;
const web = mkdtempSync(join(tmpdir(), 'hall-web-'));
beforeAll(async () => {
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Farad Hall</title>');
  t = await startHall({ webDir: web });
});
afterAll(async () => t?.stop());

it('serves the files, the app on client-side routes, and JSON 404s elsewhere', async () => {
  // A file written after start (a rebuild) is served too.
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'assets', 'app-123.js'), 'console.log(1)');
  const js = await fetch(`${t.url}/assets/app-123.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get('content-type')).toMatch(/javascript/);
  for (const path of ['/', '/devices/0b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', '/customers']) {
    const r = await fetch(t.url + path);
    expect(r.status, path).toBe(200);
    expect(await r.text()).toContain('Farad Hall');
  }
  expect((await fetch(`${t.url}/assets/missing.js`)).status).toBe(404);
  const api = await fetch(`${t.url}/api/nothing-here`);
  expect(api.status).toBe(404);
  expect(((await api.json()) as { error: string }).error).toBe('not-found');
});
