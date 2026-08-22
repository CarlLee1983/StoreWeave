import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const cartMigrations: MigrationSet = {
  module: 'cart',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS cart_carts (
  id               uuid PRIMARY KEY,
  customer_id      uuid,
  guest_token_hash text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- 一台車要嘛屬於一個會員、要嘛屬於一個訪客 token，不會兩個都有或都沒有。
  CONSTRAINT cart_owner_present CHECK ((customer_id IS NULL) <> (guest_token_hash IS NULL))
);
-- 一個顧客最多一台開著的車；訪客 token 同理。
CREATE UNIQUE INDEX IF NOT EXISTS cart_carts_customer_open_idx
  ON cart_carts (customer_id) WHERE status = 'open' AND customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cart_carts_guest_open_idx
  ON cart_carts (guest_token_hash) WHERE status = 'open' AND guest_token_hash IS NOT NULL;
-- 訪客購物車的清理查的是「多久沒動」。
CREATE INDEX IF NOT EXISTS cart_carts_stale_idx ON cart_carts (updated_at) WHERE customer_id IS NULL;

CREATE TABLE IF NOT EXISTS cart_items (
  id         uuid PRIMARY KEY,
  cart_id    uuid NOT NULL REFERENCES cart_carts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, product_id)
);
CREATE INDEX IF NOT EXISTS cart_items_cart_idx ON cart_items (cart_id);
`),
  ],
};
