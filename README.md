# Farad Hall

*Hall*: the central that manages every **Farad Orquestra** in the field.

Each Orquestra (a condominium, a charging station) reports to Hall: who it is, whether it is
online, which version it runs, its health, its control mode, its chargers, its warning and critical
events. Hall shows the fleet, raises alerts, and keeps an audit log of every change. Hall is never
in the load-control loop: an Orquestra without Hall, or without internet, keeps controlling,
charging and recording on its own.

This repository is **phase 1 (Frota), first slice** of the scope (`specs/farad-hall.md` in the
Orquestra repository): the Hall protocol v1, device identity and enrolment, people with roles and
scopes, customers and sites, the fleet view, the first alert rules, the web UI, and the server
deployment.

| | |
|---|---|
| `packages/protocol` | **The Hall protocol** (zod schemas, version negotiation, Ed25519 request signing, claim codes): the only contract with the Orquestra's hall-agent |
| `protocol/v1/` | The protocol, generated, for the Orquestra to vendor: OpenAPI 3.1, JSON Schemas, signing test vectors, [README](protocol/v1/README.md) |
| `apps/hall-api` | Fastify 5 + zod 4 API, Postgres, migrations, alerts, jobs, CLI |
| `apps/hall-web` | React + Vite web UI (pt-BR, English), the Farad look |
| `tools/device-sim` | A simulated hall-agent: enrols with a claim code, signs and sends heartbeats, state and events |
| `packages/openapi` | zod schemas → OpenAPI 3.1 (named components, request/answer variants) |
| `packages/test-support` | A private Postgres per test run |
| `deploy/` | Docker Compose for the dedicated server: Caddy, hall-api, Postgres, nightly backups, MinIO |
| `docs/api/openapi.json` | The whole API contract (people and devices), generated |

## Run it locally

Needs Node 22, pnpm 10 (`corepack enable`), and Postgres server binaries (`apt install postgresql`;
any version from 13) or a Docker daemon: the tests and the demo start their own private Postgres.

```sh
pnpm install
pnpm test            # every test: protocol, signatures, API on a real Postgres, web UI in jsdom
pnpm demo            # a local Hall with five simulated Orquestras
```

`pnpm demo` builds the web UI, starts a private Postgres and Hall at <http://127.0.0.1:8080>, signs
in `admin@farad.local` / `farad-hall-demo`, creates a reseller, customers and sites, creates a claim
code per site and enrols one simulated device with each. The devices keep sending heartbeats (every
15 s in the demo) and state: *Mar Azul · Torre A* is in fallback (an open alert), *Eletroposto Rota
324* sent a critical event, *CD Camaçari* went quiet 20 minutes ago (offline alert). The last 24 h of
presence are filled in (with an outage on *Torre B*). `HALL_DEMO_PORT` changes the port;
`DATABASE_URL` uses your own database instead of a private one.

Other ways in:

```sh
# The API with hot reload against your database, and the UI with hot reload (proxying /api to it).
DATABASE_URL=postgres://… HALL_COOKIE_SECURE=0 HALL_ADMIN_EMAIL=me@farad.local HALL_ADMIN_PASSWORD=… \
  pnpm --filter @hall/api dev
pnpm --filter @hall/web dev

# A simulated Orquestra against any Hall (create a claim code in Hall first: Códigos de vínculo).
pnpm --filter @hall/device-sim sim --url http://localhost:8080 --claim K7QM-4TZP --identity .device-sim/a.json
#   --fallback (control in fallback)  --critical (send a critical event)  --once  --heartbeat 60 --state 300

# Operations (also inside the hall-api container: node dist/cli.js …)
pnpm --filter @hall/api exec tsx --conditions=source src/cli.ts migrate
HALL_NEW_PASSWORD=… pnpm --filter @hall/api exec tsx --conditions=source src/cli.ts create-admin ana@farad.com.br Ana
```

After changing a protocol schema or a route: `pnpm generate` rewrites `protocol/v1/` and
`docs/api/openapi.json`; the tests fail while either is out of date.

## The Hall protocol

The contract between Hall and the Orquestra's future `hall-agent`, versioned on its own
(`protocolVersion: 1` in every message). Details, the canonical string and test vectors:
[protocol/v1/README.md](protocol/v1/README.md).

| Message | Path | When |
|---|---|---|
| Enrolment: claim code + public key + device info → `deviceId` | `POST /api/device/enrol` | once |
| Heartbeat: version, uptime, LAN IP, image digest (Hall records the public IP it sees and answers it) | `POST /api/device/heartbeat` | every 60 s |
| State: services' health, CPU/memory/disk/temperature, control mode, chargers' connector states | `POST /api/device/state` | every 5 min and on a control mode change |
| Events: the Orquestra's warning and critical events, idempotent by event id | `POST /api/device/events` | as they happen |
| Acknowledgement: `protocolVersion` accepted, Hall's time, the public IP, accepted/duplicate events, the intervals Hall wants | every answer | |

- **Versions.** Hall reads `protocolVersion` first, validates the message with that version's
  schema and upgrades it to the current shape (`packages/protocol/src/versions.ts`). It accepts the
  current version and the one before (`SUPPORTED_PROTOCOL_VERSIONS`), so the fleet can update
  gradually; anything else is 422 `unsupported-protocol` with the versions it accepts. Within a
  version, receivers ignore unknown fields and enums are closed.
- **Vendoring.** The Orquestra copies `protocol/v1/` as it is; its CI compares the copy with the
  version it implements. Nothing of Hall's code goes into the Orquestra (D12): the agent implements
  the protocol from these files and checks its signing against `test-vectors.json`.
- **Transport.** HTTPS requests from the device (outbound only, through NAT and 4G). The
  long-lived WebSocket of the scope (§5) comes with the support tunnel and remote configuration.

## Device identity: Ed25519 request signatures (not mTLS)

The scope (§5) says mTLS with a certificate Hall issues at enrolment. This slice implements the
same guarantees with **Ed25519 signatures on every request** instead:

1. The device generates an Ed25519 key pair; the private key never leaves it.
2. An admin creates a **claim code** for a site in Hall (8 characters without look-alikes, single
   use, 24 h; Hall stores only its SHA-256 and shows it once). The installer types it into the
   Orquestra.
3. The device enrols with the code and its public key, **signed with that key** (proof of
   possession). Hall registers the device under the site.
4. Every later request is signed over `method, path, timestamp, nonce, SHA-256(body), device id`.
   Hall refuses a timestamp more than 300 s off (answering its own time, so the agent corrects its
   offset), a nonce already seen from that device in 600 s (kept in Postgres), a bad signature, an
   unknown device; a **revoked** device gets 403 `device-revoked`.

Why not mTLS now:

- **Behind Caddy.** TLS ends at Caddy. mTLS would need Caddy to verify client certificates against
  Hall's CA and pass the identity to hall-api in a header that hall-api must trust, plus a CRL or
  OCSP path for revocation. Every proxy, CDN or load balancer added later would have to do the same.
  A signature is checked by hall-api itself, end to end, whatever is in front of it.
- **No CA to run.** No certificate issuance, expiry, renewal or revocation lists; revoking is one
  row. A device's identity is its key, never a copy.
- **Request integrity and replay protection** come with it: a signature covers the body and is
  bound to a timestamp and a nonce. mTLS authenticates the channel, not each message.
- **Testable to the byte.** Ed25519 is deterministic: `protocol/v1/test-vectors.json` lets the
  agent's implementation be checked offline.

What it costs: the agent signs each request (microseconds), and confidentiality relies on ordinary
server-authenticated TLS (as with mTLS). Moving to mTLS later is additive: Hall would sign a client
certificate for the same Ed25519 key at enrolment, and the signature check would stay as a second
factor or be dropped.

## People, roles and scopes

People sign in with e-mail and password (scrypt, N = 2^15; five failures in 15 minutes lock the
address out). The session is a random token in an httpOnly, SameSite=Strict, Secure cookie; Postgres
keeps only its hash. A cross-origin change is refused even with the cookie. Changing a password ends
the person's other sessions; disabling a person ends them all.

Roles: `admin-farad`, `financeiro`, `suporte`, `revenda`, `cliente`, each at a scope: Farad
(everything), a reseller, a customer or a site (`role_assignments`). Every query is filtered by the
scope of the permission it needs (`apps/hall-api/src/auth/rbac.ts`); a `cliente` of a customer sees
only that customer's sites and devices, a `revenda` creates claim codes only for its own sites. In
this slice only `admin-farad` has screens; people and roles are managed through the API
(`/api/users`) and the CLI.

The **audit log** records every change (who, what, before and after, from which address): people,
customers, sites, claim codes, devices (enrolment, rename, transfer, revocation), alerts (opened,
acknowledged, closed), settings, sign-ins and failed sign-ins. Secrets are never written to it.

## Alerts

| Rule | Opens | Closes |
|---|---|---|
| `device-offline` | no message from an active device for more than N minutes (setting, default 5; checked every 30 s) | by itself at the next message |
| `control-fallback` | a state in `fallback-analyzer` or `fallback-error` | by itself when a state says otherwise |
| `critical-event` | a critical event (one alert per event kind and charger; repeats count on it) | by a person |

An alert is open, acknowledged (someone is on it, with a note), then closed (with a note). At most
one alert per device, rule and key is not closed (a unique index). Opening and auto-closing commit
with the telemetry that caused them; e-mails go out afterwards, best effort, through a `Mailer`
interface: SMTP (`SMTP_HOST`), or a log line when no SMTP server is set; the tests use a memory
mailer. Recipients and the threshold are settings (`/api/settings/alerts`).

## Data

Postgres (13+; tested on 16 and 18), plain SQL migrations in `apps/hall-api/migrations`, applied at start (or `hall
migrate`) in order, each in a transaction, under an advisory lock, with a checksum so an applied
migration cannot change silently.

Telemetry tables (`heartbeats`, `device_states`, `device_events`) are append-only, indexed by
`(device_id, time DESC)` with BRIN indexes on time for pruning; the device row keeps the latest of
everything, so the fleet view reads one row per device. An hourly job prunes by age
(`HALL_RETENTION_*_DAYS`: heartbeats 14 d, states 30 d, events 400 d, audit 5 y).

**No TimescaleDB in this slice.** A heartbeat a minute is about 1 400 rows per device per day; with
the retention above, a fleet of hundreds of sites stays in the low millions of rows, which plain
Postgres with these indexes handles well, and the same migrations run in tests on any Postgres.
Timescale (hypertables, compression, continuous aggregates for the failure index of phase 4) is the
next step when the fleet grows to thousands, as a migration that converts these tables.

## The API

`docs/api/openapi.json` (OpenAPI 3.1; also served at `GET /api/openapi.json`) is generated from the
same zod schemas the routes validate with, and the tests check every answer against it. The device
routes are documented exactly as `protocol/v1/openapi.json` documents them. Errors are always
`{ error, message, hint?, issues? }`.

## Configuration

hall-api reads its environment (`apps/hall-api/src/config.ts`; `deploy/.env.example` for the
server):

| Key | Default | |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres |
| `HALL_PORT`, `HALL_HOST` | 8080, 0.0.0.0 | |
| `HALL_PUBLIC_URL` | | Links in e-mails |
| `HALL_TRUST_PROXY` | false | Hops of reverse proxies to trust for the client address (1 behind Caddy) |
| `HALL_COOKIE_SECURE` | 1 | 0 only for plain-HTTP development |
| `HALL_SESSION_TTL_H` | 12 | |
| `HALL_ADMIN_EMAIL`, `HALL_ADMIN_PASSWORD` | | The first admin-farad, created when there is nobody yet |
| `HALL_WEB_DIR` | | Serve the built web UI from hall-api (the server uses Caddy instead) |
| `HALL_HEARTBEAT_S`, `HALL_STATE_S` | 60, 300 | The intervals Hall asks devices for; online = a message within 3 heartbeat intervals |
| `HALL_ALERT_OFFLINE_MIN`, `HALL_ALERT_RECIPIENTS` | 5, none | Defaults of the alert settings |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | | E-mail; without `SMTP_HOST` e-mails are logged |
| `HALL_RETENTION_HEARTBEATS_DAYS`, `…_STATES_DAYS`, `…_EVENTS_DAYS`, `…_AUDIT_DAYS` | 14, 30, 400, 1830 | |
| `HALL_MIGRATE`, `HALL_JOBS` | 1, 1 | Apply migrations at start; run the background jobs |

## Installing on a server

A dedicated server (D8) with Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM and 40 GB SSD is plenty for
hundreds of sites. Preferably in Brazil (LGPD, latency).

**1. DNS.** An `A` (and `AAAA`) record for Hall's name, e.g. `hall.farad.com.br`, pointing at the
server. Caddy gets the certificate from Let's Encrypt on first start, so ports 80 and 443 must be
reachable from the internet.

**2. Base system** (as root, once):

```sh
apt update && apt -y upgrade && apt -y install ca-certificates curl git ufw unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
adduser --disabled-password --gecos '' farad && usermod -aG sudo farad
# SSH by key only: put the admins' keys in ~farad/.ssh/authorized_keys, then
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh
```

**3. Firewall:** SSH only from the admins' addresses, 80 and 443 from anywhere.

```sh
ufw default deny incoming && ufw default allow outgoing
ufw allow from 203.0.113.10 to any port 22 proto tcp     # one line per admin address
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable
```

Docker publishes container ports through its own iptables chain, bypassing ufw: that is why only
Caddy publishes ports in `deploy/compose.yaml`. Postgres, MinIO and hall-api are reachable only on
the compose network.

**4. Docker** (the official repository):

```sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update && apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker farad
```

**5. Hall** (as `farad`):

```sh
git clone https://github.com/gtovieira/farad-hall.git && cd farad-hall/deploy
cp .env.example .env && chmod 600 .env
# Fill in HALL_DOMAIN, HALL_ACME_EMAIL, POSTGRES_PASSWORD and MINIO_ROOT_PASSWORD (openssl rand -base64 32),
# HALL_ADMIN_EMAIL and HALL_ADMIN_PASSWORD (the first admin), SMTP_* and HALL_ALERT_RECIPIENTS.
HALL_VERSION=$(git describe --tags --always) docker compose up -d --build
docker compose ps            # every service running, hall-api healthy
curl -fsS https://hall.farad.com.br/api/health
```

Sign in at `https://<HALL_DOMAIN>` with the first admin, change nothing else in `.env`, and remove
`HALL_ADMIN_PASSWORD` from it (it is only read when there is no user yet).

**Updating:** `git pull && HALL_VERSION=$(git describe --tags --always) docker compose up -d --build`.
Migrations run when hall-api starts.

**Backups.** The `backup` service dumps the database every night (`BACKUP_HOUR_UTC`, default 06:00
UTC = 03:00 in Brasília) into `deploy/backups/` (`HALL_BACKUP_DIR`), keeping 14 days. Copy that
directory off the server too, e.g. with a nightly `rclone sync` or `restic backup` from the host's
crontab to another provider. To restore on this or another server (with the same compose):

```sh
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U hall -d hall --clean --if-exists < backups/hall-YYYYMMDD-HHMMSS.dump
docker compose up -d
```

Test a restore on a scratch server now and then: a backup is only as good as its last restore.

**MinIO** (S3-compatible, for the Orquestras' logs) runs with a `hall-logs` bucket created by
`minio-init`; nothing writes to it yet. It is not exposed: the next slice gives each device its own
upload credential and publishes the S3 endpoint through Caddy. MinIO's community images stopped at
`RELEASE.2025-09-07`; if a newer S3 server is needed, Garage or SeaweedFS fit the same place.

## Decisions taken in this slice

| | Decision |
|---|---|
| Device authentication | Ed25519 request signatures (above), not mTLS |
| Transport | HTTPS requests from the device; WebSocket later with the tunnel and remote configuration |
| Time series | Plain Postgres with indexes and retention; Timescale later |
| Libraries | Fastify 5, zod 4 (its own JSON Schema output, no extra converter), `pg`, `nodemailer`, React 18 + Vite 7, vitest; Node's `crypto` for Ed25519 and scrypt (no native modules) |
| Migrations | Plain SQL files and a 60-line runner (checksums, advisory lock) |
| Claim codes | Created in Hall by an admin for a site, typed into the Orquestra (the scope's D14 left where the code is shown open) |
| Web UI | Self-contained: the Farad tokens and fonts copied from the Orquestra's design system, small components of its own; a 30-line router instead of a routing library |
| Serving the UI | Caddy serves the static build on the server; hall-api can serve it too (`HALL_WEB_DIR`, the demo) |

## Next slices

- **Logs:** a per-device S3 credential (MinIO user and policy limited to `hall-logs/<site>/`) handed
  to the agent, the log-uploader pointed at Hall, search by site, service and period.
- **The Orquestra's `hall-agent`** (in the Orquestra repository): key generation, the claim-code
  field in the portal, a local queue for what could not be sent, heartbeats, state from the bus and
  the health endpoint, events, clock offset from Hall's answers, `FARAD_HALL=1`.
- **Inventory** (chargers, meters, inverter, battery) in the state, and device replacement keeping
  a site's history.
- **More alert rules** (main meter lost, charger offline or faulted for N minutes, invariant
  violated, disk above 90 %, update failed), escalation, WhatsApp and push.
- **Remote configuration** (desired and applied configuration, tariffs and registers), the support
  tunnel, batched updates with rollback (phase 3).
- **Billing** (phase 2): plans, contracts, the monthly count of served units, invoices through
  Asaas, NFS-e, dunning, the signed license and the blocking levels.
- **Screens for the other roles** and reseller branding (phase 4), the failure index.
