// The contract: committed and current, every route in it, and the device routes exactly the protocol's.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from '@hall/openapi';
import { protocolDocument } from '@hall/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_CONTRACT_FILE, contract } from '../src/index.js';
import { startHall, type TestHall } from './helpers.js';

const root = join(import.meta.dirname, '..', '..', '..');
const doc = contract() as any;

let t: TestHall;
beforeAll(async () => {
  t = await startHall();
});
afterAll(async () => t?.stop());

describe('the API contract', () => {
  it('is committed and current (pnpm --filter @hall/api openapi)', () => {
    expect(readFileSync(join(root, API_CONTRACT_FILE), 'utf8')).toBe(stringify(doc));
  });

  it('lists every route Hall registered, and only those', () => {
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${path}`));
    const registered = t.hall.routes.map((r) => `${r.method} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
    expect(documented.sort()).toEqual(registered.sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('describes the device routes exactly as the Hall protocol does', () => {
    const p = protocolDocument() as any;
    for (const [path, ops] of Object.entries(p.paths)) {
      const mine = doc.paths[path];
      expect(mine, path).toBeDefined();
      const { tags: _a, ...theirs } = (ops as any).post;
      const { tags: _b, ...ours } = mine.post;
      expect(ours, path).toEqual(theirs);
    }
    for (const name of Object.keys(p.components.schemas)) expect(doc.components.schemas[name], name).toEqual(p.components.schemas[name]);
  });

  it('is served at /api/openapi.json', async () => {
    const a = await t.client().get('/api/openapi.json');
    expect(a.status).toBe(200);
    expect(a.body).toEqual(JSON.parse(stringify(doc)));
  });

  it('every operation has a summary, a tag and an answer', () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops as Record<string, any>)) {
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(op.tags?.length, `${method} ${path}`).toBe(1);
        expect(Object.keys(op.responses).some((s) => Number(s) < 300), `${method} ${path}`).toBe(true);
      }
    }
  });
});
