import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const couponMigrations: MigrationSet = {
  module: 'coupon',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS coupon_coupons (
  id           uuid PRIMARY KEY,
  code         text NOT NULL,
  promotion_id uuid NOT NULL REFERENCES promotion_promotions(id),
  status       text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used', 'void')),
  customer_id  uuid,
  partner_code text,
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupon_period_valid CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
-- 碼一律以大寫比對：顧客打小寫、客服念錯大小寫都要能對上同一張券。
CREATE UNIQUE INDEX IF NOT EXISTS coupon_coupons_code_idx ON coupon_coupons (upper(code));
CREATE INDEX IF NOT EXISTS coupon_coupons_owner_idx ON coupon_coupons (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id             uuid PRIMARY KEY,
  coupon_id      uuid NOT NULL REFERENCES coupon_coupons(id),
  promotion_id   uuid NOT NULL,
  order_id       uuid NOT NULL,
  customer_id    uuid NOT NULL,
  code           text NOT NULL,
  partner_code   text,
  discount_cents integer NOT NULL CHECK (discount_cents >= 0),
  redeemed_at    timestamptz NOT NULL DEFAULT now(),
  -- 同一張訂單不會核銷同一張券兩次。
  UNIQUE (order_id, coupon_id)
);
CREATE INDEX IF NOT EXISTS coupon_redemptions_coupon_idx ON coupon_redemptions (coupon_id);
-- 行銷分析查的是「這段期間、這個活動／夥伴帶來多少」。
CREATE INDEX IF NOT EXISTS coupon_redemptions_promotion_idx ON coupon_redemptions (promotion_id, redeemed_at);
CREATE INDEX IF NOT EXISTS coupon_redemptions_partner_idx ON coupon_redemptions (partner_code, redeemed_at)
  WHERE partner_code IS NOT NULL;
`),
    sqlMigration('0002_limits', 'expand', `
-- 限量與每人限用。總量以條件更新扣減（見 CouponRepository.consume），
-- 每人次數在鎖住券那一列之後以計數判斷——兩者都不靠應用層先讀後寫。
ALTER TABLE coupon_coupons ADD COLUMN IF NOT EXISTS max_redemptions integer;
ALTER TABLE coupon_coupons ADD COLUMN IF NOT EXISTS redeemed_count integer NOT NULL DEFAULT 0;
ALTER TABLE coupon_coupons ADD COLUMN IF NOT EXISTS per_customer_limit integer;
ALTER TABLE coupon_coupons DROP CONSTRAINT IF EXISTS coupon_redeemed_count_valid;
ALTER TABLE coupon_coupons ADD CONSTRAINT coupon_redeemed_count_valid
  CHECK (redeemed_count >= 0 AND (max_redemptions IS NULL OR redeemed_count <= max_redemptions));
CREATE INDEX IF NOT EXISTS coupon_redemptions_customer_idx
  ON coupon_redemptions (promotion_id, customer_id);
`),
    sqlMigration('0003_issuance', 'expand', `
-- 發放來源與去重。事件重投與排程重跑靠唯一索引擋下第二張券，
-- 而不是靠呼叫端先查一次「這個人領過了嗎」——那是一個會輸給併發的判斷。
ALTER TABLE coupon_coupons ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE coupon_coupons ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE coupon_coupons ADD COLUMN IF NOT EXISTS issue_key text;
CREATE UNIQUE INDEX IF NOT EXISTS coupon_coupons_issue_key_idx
  ON coupon_coupons (issue_key) WHERE issue_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS coupon_coupons_batch_idx ON coupon_coupons (batch_id) WHERE batch_id IS NOT NULL;
`),
  ],
};
