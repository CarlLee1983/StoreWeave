import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const loyaltyMigrations: MigrationSet = {
  module: 'loyalty',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS loyalty_reward_entries (
  id            uuid PRIMARY KEY,
  customer_id   uuid NOT NULL,
  amount_cents  integer NOT NULL,
  source        text NOT NULL,
  reference     text,
  effective_at  timestamptz NOT NULL,
  expires_at    timestamptz,
  actor_id      text,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- 餘額的推導要讀一位顧客的整本帳，因此索引是「這個人的、依時間」。
CREATE INDEX IF NOT EXISTS loyalty_reward_customer_idx
  ON loyalty_reward_entries (customer_id, created_at, id);
-- 同一張訂單只累積一次、只回沖一次。冪等靠這個索引，不靠呼叫端先查一次。
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_reward_reference_idx
  ON loyalty_reward_entries (source, reference) WHERE reference IS NOT NULL;
-- 流通在外的總額與到期通知都掃這一欄。
CREATE INDEX IF NOT EXISTS loyalty_reward_expiry_idx
  ON loyalty_reward_entries (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS loyalty_settings (
  id                    text PRIMARY KEY,
  accrual_basis_points  integer NOT NULL CHECK (accrual_basis_points >= 0),
  effective_after_days  integer NOT NULL CHECK (effective_after_days >= 0),
  expires_after_days    integer CHECK (expires_after_days IS NULL OR expires_after_days > 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- 預設值：回饋 1%、七天後生效、一年到期（使用者 2026-08-22 拍板）。
-- 七天涵蓋多數退貨期，避免退貨後購物金已經被花掉。
INSERT INTO loyalty_settings (id, accrual_basis_points, effective_after_days, expires_after_days)
VALUES ('singleton', 100, 7, 365)
ON CONFLICT (id) DO NOTHING;
`),
    sqlMigration('0002_tiers', 'expand', `
CREATE TABLE IF NOT EXISTS loyalty_tier_entries (
  id          uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  points      integer NOT NULL,
  source      text NOT NULL,
  reference   text,
  earned_at   timestamptz NOT NULL,
  actor_id    text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 等級的推導要讀一位顧客在滾動期間內的分錄。
CREATE INDEX IF NOT EXISTS loyalty_tier_customer_idx ON loyalty_tier_entries (customer_id, earned_at);
-- 同一張訂單只累積一次、只扣回一次。
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tier_reference_idx
  ON loyalty_tier_entries (source, reference) WHERE reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id                      uuid PRIMARY KEY,
  name                    text NOT NULL,
  threshold_points        integer NOT NULL CHECK (threshold_points >= 0),
  multiplier_basis_points integer NOT NULL CHECK (multiplier_basis_points > 0),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
-- 門檻不能重複，否則「這是哪一級」就有兩個答案。
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tiers_threshold_idx ON loyalty_tiers (threshold_points);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tiers_name_idx ON loyalty_tiers (name);

-- 預設三級。保底那一級的門檻必須是 0：沒有它，新會員不屬於任何等級。
INSERT INTO loyalty_tiers (id, name, threshold_points, multiplier_basis_points) VALUES
  ('00000000-0000-4000-8000-000000000001', '一般會員', 0, 10000),
  ('00000000-0000-4000-8000-000000000002', '銀卡', 3000, 12000),
  ('00000000-0000-4000-8000-000000000003', '金卡', 10000, 15000)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS loyalty_customer_tiers (
  customer_id        uuid PRIMARY KEY,
  tier_name          text NOT NULL,
  points             integer NOT NULL,
  previous_tier_name text,
  recalculated_at    timestamptz NOT NULL
);
-- 重算要找「最久沒算過的那一批」。
CREATE INDEX IF NOT EXISTS loyalty_customer_tiers_stale_idx ON loyalty_customer_tiers (recalculated_at);
`),
  ],
};
