import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const customerMigrations: MigrationSet = {
  module: 'customer',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS customer_customers (
  id           uuid PRIMARY KEY,
  account_id   uuid NOT NULL UNIQUE REFERENCES platform_users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  birthday     text,
  phone        text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
`),
  ],
};
