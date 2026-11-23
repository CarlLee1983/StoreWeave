import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const notificationsMigrations: MigrationSet = {
  module: 'platform-notifications',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_notifications (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  template_id text NOT NULL,
  template_version integer NOT NULL,
  locale text,
  recipient_user_id text,
  recipient_email text,
  recipient_name text,
  template jsonb NOT NULL,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  title text,
  body text,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX IF NOT EXISTS platform_notifications_recipient_idx
  ON public.platform_notifications (recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.platform_notification_deliveries (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES public.platform_notifications (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'inapp')),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'unknown')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  external_ref text,
  last_error text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (notification_id, channel)
);
CREATE INDEX IF NOT EXISTS platform_notification_deliveries_status_idx
  ON public.platform_notification_deliveries (status, updated_at DESC);
`), sqlMigration('0002_email_resends', 'expand', `
CREATE TABLE public.platform_notification_email_resends (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES public.platform_notification_deliveries (id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  previous_status text NOT NULL CHECK (previous_status IN ('unknown', 'failed')),
  expected_attempts integer NOT NULL CHECK (expected_attempts >= 0),
  mail_attempts integer NOT NULL CHECK (mail_attempts >= 0),
  acknowledge_duplicate_risk boolean NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX platform_notification_email_resends_active_idx
  ON public.platform_notification_email_resends (delivery_id) WHERE completed_at IS NULL;
CREATE INDEX platform_notification_email_resends_delivery_idx
  ON public.platform_notification_email_resends (delivery_id);
`)],
};
