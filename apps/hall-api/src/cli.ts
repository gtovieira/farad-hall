#!/usr/bin/env node
// hall <command>: operations on a Hall installation.
//   migrate                         apply the database migrations
//   create-admin <email> <name>     add an admin-farad (password from HALL_NEW_PASSWORD or stdin)
//   openapi [--check]               write docs/api/openapi.json (or check it is current)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from '@hall/openapi';
import { contract } from './app.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth/passwords.js';
import { Db, migrate } from './db.js';
import { API_CONTRACT_FILE } from './openapi.js';

const [cmd, ...args] = process.argv.slice(2);

async function readPassword(): Promise<string> {
  if (process.env['HALL_NEW_PASSWORD']) return process.env['HALL_NEW_PASSWORD'];
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function db(): Db {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('set DATABASE_URL');
  return new Db(url, 2);
}

switch (cmd) {
  case 'migrate': {
    const d = db();
    const applied = await migrate(d);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'the database is current');
    await d.close();
    break;
  }
  case 'create-admin': {
    const [email, ...name] = args;
    if (!email || name.length === 0) throw new Error('usage: hall create-admin <email> <name>   (password from HALL_NEW_PASSWORD or stdin)');
    const password = await readPassword();
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`the password needs at least ${MIN_PASSWORD_LENGTH} characters`);
    const d = db();
    await migrate(d);
    const hash = await hashPassword(password);
    await d.tx(async (tx) => {
      const u = await d.one<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name.join(' '), hash], tx);
      await d.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, 'admin-farad')", [u!.id], tx);
      await d.query("INSERT INTO audit_log (actor_type, actor_label, action, entity_type, entity_id, after) VALUES ('system', 'cli', 'user.create', 'user', $1, $2)", [u!.id, JSON.stringify({ email, role: 'admin-farad' })], tx);
    });
    console.log(`admin-farad ${email} created`);
    await d.close();
    break;
  }
  case 'openapi': {
    const file = join(import.meta.dirname, '..', '..', '..', API_CONTRACT_FILE);
    const text = stringify(contract());
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // not written yet
    }
    if (args.includes('--check')) {
      if (current !== text) {
        console.error(`${API_CONTRACT_FILE} is out of date: run pnpm --filter @hall/api openapi`);
        process.exit(1);
      }
      console.log(`${API_CONTRACT_FILE} is current`);
    } else if (current === text) console.log(`${API_CONTRACT_FILE} unchanged`);
    else {
      writeFileSync(file, text);
      console.log(`${API_CONTRACT_FILE} written`);
    }
    break;
  }
  default:
    console.error('usage: hall migrate | create-admin <email> <name> | openapi [--check]');
    process.exit(2);
}
