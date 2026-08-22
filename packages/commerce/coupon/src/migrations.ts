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
  ],
};
