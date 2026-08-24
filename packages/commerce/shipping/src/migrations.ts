import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const shippingMigrations: MigrationSet = {
  module: 'shipping',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS shipping_methods (
  id                              uuid PRIMARY KEY,
  code                            text NOT NULL UNIQUE,
  name                            text NOT NULL,
  provider                        text NOT NULL,
  type                            text NOT NULL,
  fee_cents                       integer NOT NULL CHECK (fee_cents >= 0),
  free_shipping_threshold_cents   integer CHECK (free_shipping_threshold_cents IS NULL OR free_shipping_threshold_cents >= 0),
  enabled                         boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipping_methods_enabled_idx ON shipping_methods (enabled, code);

CREATE TABLE IF NOT EXISTS shipping_shipments (
  id                  uuid PRIMARY KEY,
  -- Cross-module order reference: deliberately no FK to order_orders (ADR 0029 / ADR 0021).
  order_id            uuid NOT NULL,
  shipping_method_id  uuid NOT NULL REFERENCES shipping_methods(id),
  provider            text NOT NULL,
  type                text NOT NULL,
  provider_ref        text,
  tracking_number     text,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'shipped', 'arrived', 'completed')),
  provider_status_raw text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  shipped_at          timestamptz,
  arrived_at          timestamptz,
  completed_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipping_shipments_order_idx ON shipping_shipments (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shipping_shipments_status_idx ON shipping_shipments (status, updated_at DESC);
-- A provider callback must identify at most one shipment; null permits manual shipments.
CREATE UNIQUE INDEX IF NOT EXISTS shipping_shipments_provider_ref_idx
  ON shipping_shipments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
`),
    sqlMigration('0002_method_destination_kind', 'expand', `
-- Existing merchant methods predate destination compatibility. Preserve their former home-delivery meaning,
-- then require every newly maintained method to state the destination it accepts.
ALTER TABLE shipping_methods ADD COLUMN IF NOT EXISTS destination_kind text NOT NULL DEFAULT 'taiwan_home';
ALTER TABLE shipping_methods DROP CONSTRAINT IF EXISTS shipping_methods_destination_kind_check;
ALTER TABLE shipping_methods ADD CONSTRAINT shipping_methods_destination_kind_check
  CHECK (destination_kind IN ('taiwan_home', 'pickup_store'));
ALTER TABLE shipping_methods ALTER COLUMN destination_kind DROP DEFAULT;
`),
  ],
};
