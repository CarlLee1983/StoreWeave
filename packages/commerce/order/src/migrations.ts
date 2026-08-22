import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const orderMigrations: MigrationSet = {
  module: 'order',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1000;

CREATE TABLE IF NOT EXISTS order_orders (
  id             uuid PRIMARY KEY,
  number         text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'pending',
  currency       text NOT NULL,
  customer_email text NOT NULL,
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  total_cents    integer NOT NULL CHECK (total_cents >= 0),
  metadata       jsonb,
  placed_at      timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  cancelled_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_orders_status_idx ON order_orders (status, placed_at DESC);

CREATE TABLE IF NOT EXISTS order_lines (
  id               uuid PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES order_orders(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL,
  sku              text NOT NULL,
  name             text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  line_total_cents integer NOT NULL CHECK (line_total_cents >= 0)
);
CREATE INDEX IF NOT EXISTS order_lines_order_idx ON order_lines (order_id);

CREATE TABLE IF NOT EXISTS order_payments (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES order_orders(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  provider_ref text NOT NULL,
  amount_cents integer NOT NULL,
  status       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
`),
    sqlMigration('0002_payment_reservations', 'expand', `
ALTER TABLE order_orders ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE order_orders DROP CONSTRAINT IF EXISTS order_orders_status_check;
ALTER TABLE order_orders ADD CONSTRAINT order_orders_status_check
  CHECK (status IN ('pending', 'payment_processing', 'paid', 'cancelled', 'expired'));
CREATE INDEX IF NOT EXISTS order_orders_expiry_idx
  ON order_orders (expires_at) WHERE status IN ('pending', 'payment_processing');
`),
    sqlMigration('0003_money_columns', 'expand', `
ALTER TABLE order_orders ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0;
ALTER TABLE order_orders DROP CONSTRAINT IF EXISTS order_orders_discount_cents_check;
ALTER TABLE order_orders ADD CONSTRAINT order_orders_discount_cents_check CHECK (discount_cents >= 0);

ALTER TABLE order_orders ADD COLUMN IF NOT EXISTS shipping_cents integer NOT NULL DEFAULT 0;
ALTER TABLE order_orders DROP CONSTRAINT IF EXISTS order_orders_shipping_cents_check;
ALTER TABLE order_orders ADD CONSTRAINT order_orders_shipping_cents_check CHECK (shipping_cents >= 0);

ALTER TABLE order_orders ADD COLUMN IF NOT EXISTS tax_cents integer NOT NULL DEFAULT 0;
ALTER TABLE order_orders DROP CONSTRAINT IF EXISTS order_orders_tax_cents_check;
ALTER TABLE order_orders ADD CONSTRAINT order_orders_tax_cents_check CHECK (tax_cents >= 0);

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0;
ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_discount_cents_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_discount_cents_check CHECK (discount_cents >= 0);
`),
    sqlMigration('0004_order_adjustments', 'expand', `
CREATE TABLE IF NOT EXISTS order_adjustments (
  id           uuid PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES order_orders(id) ON DELETE CASCADE,
  source       text NOT NULL,
  source_id    text NOT NULL,
  name         text NOT NULL,
  amount_cents integer NOT NULL,
  sort_order   integer NOT NULL
);
CREATE INDEX IF NOT EXISTS order_adjustments_order_idx ON order_adjustments (order_id, sort_order);
-- 行銷分析要問的是「這檔活動折掉了多少」。
CREATE INDEX IF NOT EXISTS order_adjustments_source_idx ON order_adjustments (source, source_id);
`),
    sqlMigration('0005_total_matches_parts', 'expand', `
-- 這批最重要的不變式：總額必須等於小計扣折扣再加運費與稅。
UPDATE order_orders
   SET total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents
 WHERE total_cents <> subtotal_cents - discount_cents + shipping_cents + tax_cents;
ALTER TABLE order_orders DROP CONSTRAINT IF EXISTS order_orders_total_matches_parts;
ALTER TABLE order_orders ADD CONSTRAINT order_orders_total_matches_parts
  CHECK (total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents);

ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_discount_within_total;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_discount_within_total
  CHECK (discount_cents <= line_total_cents);
`),
    sqlMigration('0006_order_customer', 'expand', `
ALTER TABLE order_orders ADD COLUMN IF NOT EXISTS customer_id uuid;
-- 「我的訂單」是會員中心的主要查詢。
CREATE INDEX IF NOT EXISTS order_orders_customer_idx ON order_orders (customer_id, placed_at DESC);
`),
  ],
};
