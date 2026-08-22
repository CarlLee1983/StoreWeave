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
    sqlMigration('0002_merged_status', 'expand', `
-- 併進會員車的訪客車就地作廢。用新狀態而不是刪除：清理工作（工單 30）
-- 才有辦法把「併過的」與「放著沒動的」分開處理。
ALTER TABLE cart_carts DROP CONSTRAINT IF EXISTS cart_carts_status_check;
ALTER TABLE cart_carts ADD CONSTRAINT cart_carts_status_check
  CHECK (status IN ('open', 'checked_out', 'merged'));
`),
    sqlMigration('0003_checkout', 'expand', `
-- 結成的訂單。重複送出的結帳靠它回到同一張單——冪等的來源是購物車本身，
-- 不是呼叫端記不記得帶對 key（Spec 0003）。
ALTER TABLE cart_carts ADD COLUMN IF NOT EXISTS order_id uuid;
`),
    sqlMigration('0004_coupon_code', 'expand', `
-- 本次要使用的券。存碼而不是券 id：券可能在結帳前被停用，
-- 屆時錯誤訊息要說得出是哪一組碼失效（Spec 0004）。
ALTER TABLE cart_carts ADD COLUMN IF NOT EXISTS coupon_code text;
`),
  ],
};
