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
    sqlMigration('0007_payment_attempts_and_awaiting_payment', 'expand', `
-- 每次向 provider 發起付款都留下自己的本地 reference；舊的成功紀錄補成 legacy attempt。
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS attempt_ref text;
UPDATE order_payments SET attempt_ref = 'legacy:' || id::text WHERE attempt_ref IS NULL;
ALTER TABLE order_payments ALTER COLUMN attempt_ref SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_attempt_ref_idx ON order_payments (attempt_ref);

ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS method text;
UPDATE order_payments SET method = 'legacy' WHERE method IS NULL;
ALTER TABLE order_payments ALTER COLUMN method SET NOT NULL;

-- 失敗可能發生在 provider 分配外部交易號以前；成功的唯一性改成 partial index。
ALTER TABLE order_payments ALTER COLUMN provider_ref DROP NOT NULL;
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_provider_provider_ref_key;
CREATE UNIQUE INDEX IF NOT EXISTS order_payments_provider_ref_idx
  ON order_payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;

ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS action jsonb;
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS instructions jsonb;
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS failure_message text;
ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE order_orders DROP CONSTRAINT IF EXISTS order_orders_status_check;
ALTER TABLE order_orders ADD CONSTRAINT order_orders_status_check
  CHECK (status IN ('pending', 'payment_processing', 'awaiting_payment', 'paid', 'cancelled', 'expired'));
DROP INDEX IF EXISTS order_orders_expiry_idx;
CREATE INDEX IF NOT EXISTS order_orders_expiry_idx
  ON order_orders (expires_at) WHERE status IN ('pending', 'payment_processing', 'awaiting_payment');
`),
    sqlMigration('0008_order_delivery_snapshot', 'expand', `
-- This table is an Order-owned fact, not a live join to shipping_methods. A method
-- can be retired or repriced without changing what the customer agreed to pay.
CREATE TABLE IF NOT EXISTS order_deliveries (
  order_id              uuid PRIMARY KEY REFERENCES order_orders(id) ON DELETE CASCADE,
  shipping_method_id    uuid NOT NULL,
  shipping_method_code  text NOT NULL,
  shipping_method_name  text NOT NULL,
  provider              text NOT NULL,
  type                  text NOT NULL,
  destination_kind      text NOT NULL,
  recipient             text NOT NULL,
  phone                 text NOT NULL,
  country_code          text,
  postcode              text,
  city                  text,
  district              text,
  line1                 text,
  line2                 text,
  provider_store_id     text,
  store_name            text,
  store_address         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_deliveries_destination_check CHECK (
    (
      destination_kind = 'taiwan_home'
      AND country_code = 'TW'
      AND postcode IS NOT NULL AND city IS NOT NULL AND district IS NOT NULL AND line1 IS NOT NULL
      AND provider_store_id IS NULL AND store_name IS NULL AND store_address IS NULL
    ) OR (
      destination_kind = 'pickup_store'
      AND provider_store_id IS NOT NULL AND store_name IS NOT NULL AND store_address IS NOT NULL
      AND country_code IS NULL AND postcode IS NULL AND city IS NULL AND district IS NULL AND line1 IS NULL AND line2 IS NULL
    )
  )
);
`),
  ],
};
