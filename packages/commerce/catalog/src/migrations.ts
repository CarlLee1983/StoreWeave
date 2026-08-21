import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const catalogMigrations: MigrationSet = {
  module: 'catalog',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS catalog_products (
  id          uuid PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency    text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_products_status_idx ON catalog_products (status);
CREATE INDEX IF NOT EXISTS catalog_products_name_trgm_idx ON catalog_products (lower(name));
`),
  ],
};
