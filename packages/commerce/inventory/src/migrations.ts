import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const inventoryMigrations: MigrationSet = {
  module: 'inventory',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS inventory_stock (
  product_id uuid PRIMARY KEY,
  on_hand    integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved   integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL,
  delta      integer NOT NULL,
  reason     text NOT NULL,
  reference  text,
  actor_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_movements_product_idx ON inventory_movements (product_id, created_at DESC);
`),
  ],
};
