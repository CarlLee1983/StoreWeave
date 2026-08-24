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
    sqlMigration('0002_shipping_address', 'expand', `
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_recipient text;
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_phone text;
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_postcode text;
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_city text;
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_line2 text;
`),
    sqlMigration('0003_taiwan_address_fields', 'expand', `
ALTER TABLE customer_customers
  ADD COLUMN IF NOT EXISTS address_country_code text NOT NULL DEFAULT 'TW';
ALTER TABLE customer_customers ADD COLUMN IF NOT EXISTS address_district text;
`),
  ],
};
