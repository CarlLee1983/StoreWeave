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
  ],
};
