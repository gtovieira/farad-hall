// The simulator on its own: identity on disk, messages valid against the protocol.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v1 } from '@hall/protocol';
import { describe, expect, it } from 'vitest';
import { SimDevice } from '../src/index.js';

describe('SimDevice', () => {
  it('writes messages that the protocol accepts', () => {
    const d = new SimDevice('http://hall.test');
    expect(v1.Heartbeat.safeParse(d.heartbeatMessage()).success).toBe(true);
    for (let i = 0; i < 20; i++) expect(v1.DeviceState.safeParse(d.stateMessage()).success).toBe(true);
    d.profile.controlMode = 'fallback-analyzer';
    expect(d.stateMessage().control).toMatchObject({ mode: 'fallback-analyzer', mainMeterOnline: false });
    expect(v1.EventBatch.safeParse({ protocolVersion: 1, events: [SimDevice.event()] }).success).toBe(true);
  });

  it('keeps its identity on disk', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sim-')), 'id.json');
    const d = new SimDevice('http://hall.test', { deviceId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b' });
    d.save(file);
    const back = SimDevice.load('http://hall.test', file);
    expect(back.keys.publicKey).toBe(d.keys.publicKey);
    expect(back.deviceId).toBe(d.deviceId);
    expect(back.profile.hostname).toBe(d.profile.hostname);
  });

  it('runs like an agent: a heartbeat, the state, and stops when aborted', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['hall-device']}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ protocolVersion: 1, accepted: true, receivedAt: new Date().toISOString() }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const d = new SimDevice(`http://127.0.0.1:${port}`, { deviceId: '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b' });
    const ctrl = new AbortController();
    const t0 = Date.now();
    const errors: string[] = [];
    const run = d.run({ heartbeatS: 3600, stateS: 3600, signal: ctrl.signal, onError: (e) => errors.push(String((e as Error & { cause?: unknown }).cause ?? e.message)) });
    setTimeout(() => ctrl.abort(), 200);
    await run;
    server.close();
    expect(errors).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(seen).toEqual(['POST /api/device/heartbeat 1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', 'POST /api/device/state 1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b']);
  });
});
