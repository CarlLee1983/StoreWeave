import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const promotionMigrations: MigrationSet = {
  module: 'promotion',
  migrations: [
    sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS promotion_promotions (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  rule_type  text NOT NULL,
  rule       jsonb NOT NULL,
  priority   integer NOT NULL DEFAULT 0,
  stackable  boolean NOT NULL DEFAULT true,
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_period_valid CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
-- 結帳的熱路徑是「此刻生效中的活動，依優先序」。
CREATE INDEX IF NOT EXISTS promotion_promotions_active_idx
  ON promotion_promotions (status, priority, id);
`),
    sqlMigration('0002_requires_coupon', 'expand', `
-- 券所指向的活動不該人人適用。沒有這個旗標，建一張券就等於全站打折。
ALTER TABLE promotion_promotions ADD COLUMN IF NOT EXISTS requires_coupon boolean NOT NULL DEFAULT false;
`),
    sqlMigration('0003_auto_issue', 'expand', `
-- 自動發券的觸發掛在活動上，而不是另做一層「發券活動」——在只有兩種觸發時，
-- 那一層是規則引擎的規則引擎（Spec 0004）。
ALTER TABLE promotion_promotions ADD COLUMN IF NOT EXISTS auto_issue text;
ALTER TABLE promotion_promotions ADD COLUMN IF NOT EXISTS auto_issue_valid_days integer;
ALTER TABLE promotion_promotions DROP CONSTRAINT IF EXISTS promotion_auto_issue_valid;
ALTER TABLE promotion_promotions ADD CONSTRAINT promotion_auto_issue_valid
  CHECK (auto_issue IS NULL OR auto_issue IN ('signup', 'birthday'));
CREATE INDEX IF NOT EXISTS promotion_auto_issue_idx ON promotion_promotions (auto_issue)
  WHERE auto_issue IS NOT NULL;
`),
    sqlMigration('0004_tier_scope', 'expand', `
-- 等級限定的活動。空陣列代表人人適用——等級不是另一套折扣系統，
-- 它只是「這條規則套不套用」的一個條件（Spec 0005）。
ALTER TABLE promotion_promotions ADD COLUMN IF NOT EXISTS tier_names text[] NOT NULL DEFAULT '{}';
`),
  ],
};
