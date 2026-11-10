#!/usr/bin/env node
// hall-device-sim: a simulated Orquestra that talks to Hall.
//
//   hall-device-sim --url http://localhost:8080 --claim K7QM-4TZP [--identity .device-sim/a.json]
//                   [--heartbeat 60] [--state 300] [--fallback] [--critical] [--once]
//
// Enrols with the claim code the first time (the identity file keeps its key and device id), then
// sends heartbeats and state until stopped. --fallback reports the control in fallback;
// --critical sends a critical event after enrolment; --once sends one of each and exits.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SimDevice } from './device.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    claim: { type: 'string' },
    identity: { type: 'string', default: '.device-sim/device.json' },
    hostname: { type: 'string' },
    heartbeat: { type: 'string', default: '60' },
    state: { type: 'string', default: '300' },
    fallback: { type: 'boolean', default: false },
    critical: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
  },
});

const log = (msg: string, data?: unknown) => console.log(`${new Date().toISOString()} ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);

const url = values.url!.replace(/\/+$/, '');
const dev = existsSync(values.identity!) ? SimDevice.load(url, values.identity!) : new SimDevice(url, { profile: values.hostname ? { hostname: values.hostname } : {} });
if (values.fallback) dev.profile.controlMode = 'fallback-analyzer';

if (!dev.deviceId) {
  if (!values.claim) {
    console.error('not enrolled yet: pass --claim <code> (create one in Hall: Claim codes)');
    process.exit(2);
  }
  const a = await dev.enrol(values.claim);
  if (a.status !== 201) {
    console.error(`enrolment refused: ${a.status} ${JSON.stringify(a.body)}`);
    process.exit(1);
  }
  dev.save(values.identity!);
  log('enrolled', { deviceId: dev.deviceId, site: a.body.site.name, customer: a.body.customer.name });
}

if (values.critical) log('events', (await dev.events([SimDevice.event()])).body);

if (values.once) {
  log('heartbeat', (await dev.heartbeat()).body);
  log('state', (await dev.state()).body);
  process.exit(0);
}

const ctrl = new AbortController();
process.once('SIGINT', () => ctrl.abort());
process.once('SIGTERM', () => ctrl.abort());
await dev.run({
  heartbeatS: Number(values.heartbeat),
  stateS: Number(values.state),
  signal: ctrl.signal,
  onAnswer: (what, a) => {
    log(`${what} ${a.status}`);
    if (a.status === 403) ctrl.abort();
  },
  onError: (err) => log(`error: ${err.message}`),
});
