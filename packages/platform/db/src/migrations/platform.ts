import { sqlMigration, type MigrationSet } from '../types';

export const platformMigrations: MigrationSet = {
  module: 'platform',
  migrations: [
    sqlMigration(
      '0001_init',
      'expand',
      `
CREATE TABLE IF NOT EXISTS platform_outbox (
  id             uuid PRIMARY KEY,
  event_name     text NOT NULL,
  event_version  integer NOT NULL,
  payload        jsonb NOT NULL,
  actor_id       text NOT NULL,
  correlation_id text NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  available_at   timestamptz NOT NULL DEFAULT now(),
  relayed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS platform_outbox_pending_idx
  ON platform_outbox (available_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS platform_jobs (
  id           uuid PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS platform_jobs_ready_idx
  ON platform_jobs (run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS platform_idempotency (
  command_name text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       text NOT NULL,
  response     jsonb,
  actor_id     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (command_name, key)
);

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id             uuid PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       text NOT NULL,
  actor_type     text NOT NULL,
  extension_id   text,
  action         text NOT NULL,
  resource_type  text NOT NULL,
  resource_id    text,
  correlation_id text NOT NULL,
  payload        jsonb
);
CREATE INDEX IF NOT EXISTS platform_audit_log_resource_idx
  ON platform_audit_log (resource_type, resource_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS platform_extension_state (
  extension_id text NOT NULL,
  key          text NOT NULL,
  value        jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_id, key)
);

CREATE TABLE IF NOT EXISTS platform_extension_registry (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  version          text NOT NULL,
  platform_version text NOT NULL,
  permissions      jsonb NOT NULL,
  installed_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
`,
    ),
    sqlMigration(
      '0002_worker_heartbeat',
      'expand',
      `
CREATE TABLE IF NOT EXISTS platform_worker_heartbeat (
  worker_id  text PRIMARY KEY,
  version    text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
    ),
  ],
};
