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
    sqlMigration('0003_expiry_notice', 'expand', `
ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS expiry_notice_days integer NOT NULL DEFAULT 14;
ALTER TABLE loyalty_settings DROP CONSTRAINT IF EXISTS loyalty_expiry_notice_days_valid;
ALTER TABLE loyalty_settings ADD CONSTRAINT loyalty_expiry_notice_days_valid CHECK (expiry_notice_days > 0);

-- 已經寄過到期通知的批次。用自己的表而不是相信 Provider 的冪等：
-- 「這一批通知過了嗎」是領域問題，換一個 Provider 不該讓顧客被通知兩次。
CREATE TABLE IF NOT EXISTS loyalty_reward_expiry_notices (
  entry_id    uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  notified_at timestamptz NOT NULL
);
`),
    sqlMigration('0004_clawback_names_batch', 'expand', `
-- 負分錄指名要扣哪一批。不指名的（折抵）照「先到期先用」由推導決定，
-- 指名的（取消訂單的扣回）只扣那一批——不指名會扣到別批頭上（工單 54、ADR 0025）。
ALTER TABLE loyalty_reward_entries ADD COLUMN IF NOT EXISTS batch_id uuid;

-- 外鍵與約束分開下，而且都具名：ADD COLUMN ... REFERENCES 在欄位已經存在時
-- 會連外鍵一起跳過，而自動命名的約束之後要 drop 得先知道 PostgreSQL 的命名規則。
--
-- 複合外鍵而不是 (batch_id) -> (id)：指名別位顧客的批次在推導裡會安靜地變成
-- 一筆扣不到任何東西的負分錄，那是寫入錯誤，該在寫入的時候就擋掉。
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_reward_id_customer_idx
  ON loyalty_reward_entries (id, customer_id);
ALTER TABLE loyalty_reward_entries DROP CONSTRAINT IF EXISTS loyalty_reward_batch_same_customer;
ALTER TABLE loyalty_reward_entries ADD CONSTRAINT loyalty_reward_batch_same_customer
  FOREIGN KEY (batch_id, customer_id) REFERENCES loyalty_reward_entries (id, customer_id);

-- 只有負分錄能指名：正分錄自己就是一批，它身上的 batch_id 推導根本不會讀。
ALTER TABLE loyalty_reward_entries DROP CONSTRAINT IF EXISTS loyalty_reward_batch_only_on_negative;
ALTER TABLE loyalty_reward_entries ADD CONSTRAINT loyalty_reward_batch_only_on_negative
  CHECK (batch_id IS NULL OR amount_cents < 0);

ALTER TABLE loyalty_reward_entries DROP CONSTRAINT IF EXISTS loyalty_reward_batch_not_self;
ALTER TABLE loyalty_reward_entries ADD CONSTRAINT loyalty_reward_batch_not_self
  CHECK (batch_id IS NULL OR batch_id <> id);

-- 擋不掉的只剩「指名另一筆負分錄」：批次必須是正分錄這件事外鍵表達不了
-- （部分唯一索引不能當外鍵目標）。那一種靠推導回傳的 unappliedClawbackCents 揭露。
--
-- 這一段自己是會鎖表的：非 CONCURRENTLY 的 CREATE UNIQUE INDEX 擋寫入，
-- 三條 ADD CONSTRAINT 各持一次 ACCESS EXCLUSIVE 掃全表驗證。migrator 把每個
-- migration 包在交易裡，所以 CONCURRENTLY 在這裡用不了。以這張表現在的規模無感；
-- 真的要縮窗口，做法是三條約束都下 NOT VALID，再拆一支走 VALIDATE CONSTRAINT。
`),
    sqlMigration('0005_backfill_clawback_batch', 'migrate', `
-- 既有的扣回列回填，讓推導只留一條路徑。reference 是 'clawback:<orderId>'，
-- 對應的累積是 (source='order-accrual', reference=<orderId>)，一對一查得到。
--
-- 與 0004 分開是因為 DDL 的 ACCESS EXCLUSIVE 會持有到交易結束——擠在一起會讓這段
-- 全表掃描也被那把鎖蓋住。0004 自己仍然會鎖（見那一支的註解），拆開只是讓窗口變短，
-- 不是讓它消失。它搬的是資料不是結構，phase 因此是 migrate。
--
-- 這段假設執行時沒有並行的舊版程式在寫新的扣回列。成立的理由是扣回今天走不到
-- （累積在付款完成才發生，取消只允許 pending），正式環境的扣回列數是 0。
-- batch_id IS NULL 的守衛讓重跑安全。
--
-- 回填不到的扣回列（對不上任何累積）會留在 batch_id IS NULL，而推導從此以
-- 「有沒有 batch_id」判斷是不是扣回——那些列會被當成不指名的扣抵，扣不到就記進
-- shortfallCents 並在讀餘額時噴 error。上面那個「0 列」的前提因此不是純粹的樂觀，
-- 下面的 RAISE NOTICE 就是讓升級的人看得到它成不成立。
UPDATE loyalty_reward_entries AS clawback
SET batch_id = accrual.id
FROM loyalty_reward_entries AS accrual
WHERE clawback.source = 'reversal'
  AND clawback.amount_cents < 0
  AND clawback.batch_id IS NULL
  AND clawback.reference LIKE 'clawback:%'
  AND accrual.source = 'order-accrual'
  AND accrual.amount_cents > 0
  AND accrual.customer_id = clawback.customer_id
  AND accrual.reference = substring(clawback.reference FROM 10);

DO $$
DECLARE stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM loyalty_reward_entries
  WHERE source = 'reversal' AND amount_cents < 0 AND batch_id IS NULL;
  IF stranded > 0 THEN
    RAISE NOTICE '% 筆扣回沒有回填到批次，它們之後會被當成不指名的扣抵（工單 54）', stranded;
  END IF;
END $$;
`),
  ],
};
