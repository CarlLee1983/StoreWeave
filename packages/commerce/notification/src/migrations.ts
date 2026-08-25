import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const notificationMigrations: MigrationSet = {
  module: 'notification',
  migrations: [sqlMigration('0001_lifecycle_deliveries', 'expand', `
CREATE TABLE IF NOT EXISTS notification_lifecycle_deliveries (
  id              uuid PRIMARY KEY,
  event_id        uuid NOT NULL,
  order_id        uuid NOT NULL,
  template        text NOT NULL,
  reference       text NOT NULL UNIQUE,
  recipient_email text NOT NULL,
  variables       jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  provider_ref    text,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, template)
);
CREATE INDEX IF NOT EXISTS notification_lifecycle_deliveries_order_idx
  ON notification_lifecycle_deliveries (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_lifecycle_deliveries_status_idx
  ON notification_lifecycle_deliveries (status, updated_at DESC);
`)],
};
