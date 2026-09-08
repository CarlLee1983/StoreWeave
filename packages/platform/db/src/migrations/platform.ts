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
    sqlMigration(
      '0003_job_occurrence_fencing',
      'expand',
      `
ALTER TABLE public.platform_jobs
  ADD COLUMN IF NOT EXISTS occurrence_id uuid DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS payload_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deferred_type text,
  ADD COLUMN IF NOT EXISTS deferred_payload jsonb,
  ADD COLUMN IF NOT EXISTS deferred_payload_version integer,
  ADD COLUMN IF NOT EXISTS deferred_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS deferred_max_attempts integer,
  ADD COLUMN IF NOT EXISTS deferred_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
UPDATE public.platform_jobs SET occurrence_id = id WHERE occurrence_id IS NULL;
ALTER TABLE public.platform_jobs ALTER COLUMN occurrence_id SET NOT NULL;
UPDATE public.platform_jobs
SET lease_expires_at = locked_at
WHERE status = 'running' AND claim_token IS NULL
  AND lease_expires_at IS NULL AND locked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_jobs_lease_idx
  ON public.platform_jobs (lease_expires_at) WHERE status = 'running';
      `,
    ),
    sqlMigration(
      '0004_job_payload_quarantine',
      'expand',
      `
CREATE TABLE IF NOT EXISTS public.platform_job_quarantine (
  id              uuid PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
  job_id          uuid NOT NULL,
  occurrence_id   uuid NOT NULL,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  payload_version integer NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_job_quarantine_occurrence_idx
  ON public.platform_job_quarantine (job_id, occurrence_id);
      `,
    ),
    sqlMigration(
      '0005_outbox_subscriber_snapshot_quarantine',
      'expand',
      `
ALTER TABLE public.platform_outbox ADD COLUMN IF NOT EXISTS subscriber_ids jsonb;
CREATE TABLE IF NOT EXISTS public.platform_outbox_quarantine (
  id              uuid PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
  outbox_id       uuid NOT NULL UNIQUE,
  event_name      text NOT NULL,
  event_version   integer NOT NULL,
  payload         jsonb NOT NULL,
  subscriber_ids  jsonb,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.platform_outbox_quarantine_audit (
  id              uuid PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
  outbox_id       uuid NOT NULL REFERENCES public.platform_outbox(id),
  action          text NOT NULL,
  subscriber_ids  jsonb,
  evidence        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_outbox_quarantine_audit_outbox_idx
  ON public.platform_outbox_quarantine_audit (outbox_id, created_at);
      `,
    ),
    sqlMigration(
      '0006_job_retention_dedupe_horizon',
      'expand',
      `
ALTER TABLE public.platform_jobs
  ADD COLUMN IF NOT EXISTS retain_until timestamptz,
  ADD COLUMN IF NOT EXISTS dedupe_until timestamptz;
ALTER TABLE public.platform_jobs ALTER COLUMN payload DROP NOT NULL;
UPDATE public.platform_jobs
SET retain_until = COALESCE(completed_at, cancelled_at, updated_at) + interval '7 days',
    dedupe_until = COALESCE(completed_at, cancelled_at, updated_at) + interval '30 days'
WHERE status IN ('completed', 'cancelled')
  AND (retain_until IS NULL OR dedupe_until IS NULL);
CREATE INDEX IF NOT EXISTS platform_jobs_retention_idx
  ON public.platform_jobs (retain_until) WHERE status IN ('completed', 'cancelled');
CREATE INDEX IF NOT EXISTS platform_jobs_dedupe_retained_idx
  ON public.platform_jobs (dedupe_until) WHERE status = 'dedupe_retained';
      `,
    ),
    sqlMigration(
      '0007_ops_listing_indexes',
      'expand',
      `
CREATE INDEX IF NOT EXISTS platform_outbox_failure_idx
  ON public.platform_outbox (occurred_at DESC, id DESC) WHERE status IN ('dead', 'quarantined');
CREATE INDEX IF NOT EXISTS platform_jobs_delivery_quarantine_idx
  ON public.platform_jobs (dedupe_key)
  WHERE status = 'quarantined' AND type = 'platform.event.deliver';
CREATE INDEX IF NOT EXISTS platform_jobs_quarantined_idx
  ON public.platform_jobs (type, id) WHERE status = 'quarantined';
CREATE INDEX IF NOT EXISTS platform_jobs_dead_idx
  ON public.platform_jobs (updated_at DESC, id) WHERE status = 'dead';
      `,
    ),
    sqlMigration(
      '0008_job_schedules',
      'expand',
      `
CREATE TABLE IF NOT EXISTS public.platform_job_schedules (
  type                text PRIMARY KEY,
  fingerprint         text NOT NULL,
  paused              boolean NOT NULL DEFAULT false,
  paused_at           timestamptz,
  last_occurrence_at  timestamptz,
  last_enqueued_at    timestamptz,
  -- 跳過的原因分開記。混成一個計數器就沒有人能從它推斷「這個排程正在出事」：
  -- 健康的多 worker 叢集本來就會一直去重，而 overlap 連續跳過才是要告警的那一種。
  skipped_catchup     bigint NOT NULL DEFAULT 0,
  skipped_paused      bigint NOT NULL DEFAULT 0,
  skipped_overlap     bigint NOT NULL DEFAULT 0,
  consecutive_overlap_skips integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
      `,
    ),
  ],
};
