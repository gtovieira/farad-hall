-- Farad Hall, phase 1 (Frota): people and their roles, the commercial tree (reseller › customer ›
-- site), devices and their telemetry, alerts, the audit log. Plain Postgres (13+): no extension.

-- ------------------------------------------------------------------ the commercial tree --

CREATE TABLE resellers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  document    text,                       -- CNPJ, normalized (no punctuation)
  email       text,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX resellers_document_key ON resellers (document) WHERE document IS NOT NULL;

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id      uuid REFERENCES resellers (id) ON DELETE RESTRICT,
  legal_name       text NOT NULL,         -- razão social
  trade_name       text,                  -- nome fantasia
  document_type    text NOT NULL CHECK (document_type IN ('cnpj', 'cpf')),
  document         text NOT NULL,         -- normalized (no punctuation)
  address          jsonb NOT NULL DEFAULT '{}',
  contacts         jsonb NOT NULL DEFAULT '[]',
  billing_contact  jsonb,                 -- responsável financeiro
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_document_key ON customers (document);
CREATE INDEX customers_reseller_idx ON customers (reseller_id);

CREATE TABLE sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('condominio', 'eletroposto', 'empresa', 'estacionamento')),
  address      jsonb NOT NULL DEFAULT '{}',
  utility      text,                      -- distribuidora
  timezone     text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_customer_idx ON sites (customer_id);

-- ------------------------------------------------------------------------------- people --

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL,
  name                 text NOT NULL,
  password_hash        text NOT NULL,
  locale               text NOT NULL DEFAULT 'pt-BR' CHECK (locale IN ('pt-BR', 'en')),
  disabled_at          timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- A role at a scope: Farad (no scope), a reseller, a customer or a site.
CREATE TABLE role_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('admin-farad', 'financeiro', 'suporte', 'revenda', 'cliente')),
  reseller_id  uuid REFERENCES resellers (id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers (id) ON DELETE CASCADE,
  site_id      uuid REFERENCES sites (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(reseller_id, customer_id, site_id) <= 1),
  CHECK (role NOT IN ('admin-farad', 'financeiro') OR num_nonnulls(reseller_id, customer_id, site_id) = 0),
  CHECK (role <> 'suporte' OR customer_id IS NULL AND site_id IS NULL),
  CHECK (role <> 'revenda' OR reseller_id IS NOT NULL),
  CHECK (role <> 'cliente' OR customer_id IS NOT NULL OR site_id IS NOT NULL)
);
CREATE UNIQUE INDEX role_assignments_key
  ON role_assignments (user_id, role, coalesce(reseller_id, customer_id, site_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE sessions (
  token_hash    bytea PRIMARY KEY,         -- SHA-256 of the cookie's token
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            inet,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ------------------------------------------------------------------------------ devices --

CREATE TABLE claim_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   bytea NOT NULL UNIQUE,       -- SHA-256 of the normalized code: the code itself is shown once
  code_hint   text NOT NULL,               -- its last two characters, to tell codes apart
  site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  label       text,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  device_id   uuid,
  revoked_at  timestamptz
);
CREATE INDEX claim_codes_site_idx ON claim_codes (site_id, created_at DESC);

CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE RESTRICT,
  name               text NOT NULL,
  public_key         text NOT NULL UNIQUE,   -- Ed25519, 32 raw bytes, base64url
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  claim_code_id      uuid REFERENCES claim_codes (id) ON DELETE SET NULL,
  enrolled_at        timestamptz NOT NULL,
  enrolled_ip        inet,
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  revoke_reason      text,
  hostname           text,
  serial             text,
  model              text,
  orquestra_version  text,
  api_version        text,
  image_digest       text,
  protocol_version   integer,
  last_seen_at       timestamptz,            -- any authenticated message
  last_heartbeat_at  timestamptz,
  public_ip          inet,
  lan_ip             inet,
  uptime_s           bigint,
  last_state_at      timestamptz,
  last_state         jsonb,
  control_mode       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_site_idx ON devices (site_id);
CREATE INDEX devices_active_seen_idx ON devices (last_seen_at) WHERE status = 'active';

ALTER TABLE claim_codes ADD CONSTRAINT claim_codes_device_fk FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL;

-- Nonces seen in signed requests, per key ('<device id>' or 'pk:<public key>' on enrolment).
CREATE TABLE device_nonces (
  key_id      text NOT NULL,
  nonce       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX device_nonces_expires_idx ON device_nonces (expires_at);

-- ---------------------------------------------------------------------------- telemetry --
-- Append-only, read by device and time; pruned by age (HALL_RETENTION_*_DAYS). The BRIN indexes
-- make the pruning cheap.

CREATE TABLE heartbeats (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id         uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  received_at       timestamptz NOT NULL,
  sent_at           timestamptz,
  version           text,
  uptime_s          bigint,
  public_ip         inet,
  lan_ip            inet,
  image_digest      text,
  protocol_version  integer NOT NULL
);
CREATE INDEX heartbeats_device_time_idx ON heartbeats (device_id, received_at DESC);
CREATE INDEX heartbeats_time_brin ON heartbeats USING brin (received_at);

CREATE TABLE device_states (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id         uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  received_at       timestamptz NOT NULL,
  sent_at           timestamptz,
  protocol_version  integer NOT NULL,
  control_mode      text NOT NULL,
  health_ok         boolean NOT NULL,
  cpu_pct           real,
  mem_pct           real,
  disk_pct          real,
  temperature_c     real,
  payload           jsonb NOT NULL
);
CREATE INDEX device_states_device_time_idx ON device_states (device_id, received_at DESC);
CREATE INDEX device_states_time_brin ON device_states USING brin (received_at);

CREATE TABLE device_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id     uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  event_id      text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('warning', 'critical')),
  kind          text NOT NULL,
  source        text NOT NULL,
  message       text NOT NULL,
  charger_id    text,
  connector_id  integer,
  meter_id      text,
  data          jsonb,
  UNIQUE (device_id, event_id)
);
CREATE INDEX device_events_device_time_idx ON device_events (device_id, occurred_at DESC);
CREATE INDEX device_events_time_brin ON device_events USING brin (received_at);

-- ------------------------------------------------------------------------------- alerts --

CREATE TABLE alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  site_id           uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  rule              text NOT NULL CHECK (rule IN ('device-offline', 'control-fallback', 'critical-event')),
  dedup_key         text NOT NULL DEFAULT '',
  severity          text NOT NULL CHECK (severity IN ('warning', 'critical')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
  title             text NOT NULL,
  details           jsonb NOT NULL DEFAULT '{}',
  occurrences       integer NOT NULL DEFAULT 1,
  opened_at         timestamptz NOT NULL,
  last_occurred_at  timestamptz NOT NULL,
  acknowledged_at   timestamptz,
  acknowledged_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  ack_note          text,
  closed_at         timestamptz,
  closed_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  close_reason      text CHECK (close_reason IN ('auto', 'manual')),
  close_note        text,
  notified_at       timestamptz
);
-- At most one alert of a rule (and key) per device that is not closed: a repeat counts on it.
CREATE UNIQUE INDEX alerts_active_key ON alerts (device_id, rule, dedup_key) WHERE status <> 'closed';
CREATE INDEX alerts_status_idx ON alerts (status, opened_at DESC);
CREATE INDEX alerts_device_idx ON alerts (device_id, opened_at DESC);

-- ---------------------------------------------------------------------- audit, settings --

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'device', 'system')),
  actor_id     text,
  actor_label  text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  ip           inet,
  user_agent   text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, at DESC);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL
);
