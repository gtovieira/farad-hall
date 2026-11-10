// pnpm --filter @hall/protocol generate: writes protocol/v<N>/ (the OpenAPI document, the JSON
// Schemas, the test vectors). `-- --check` only says whether the committed files are current.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { protocolFiles } from './files.js';

const root = join(import.meta.dirname, '..', '..', '..');
const check = process.argv.includes('--check');
let stale = 0;
for (const [rel, text] of Object.entries(protocolFiles())) {
  const file = join(root, rel);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // not written yet
  }
  if (current === text) continue;
  stale++;
  if (check) console.error(`${rel} is out of date`);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`${rel} written`);
  }
}
if (check && stale) {
  console.error('run: pnpm --filter @hall/protocol generate');
  process.exit(1);
}
if (!stale) console.log('protocol files are current');
