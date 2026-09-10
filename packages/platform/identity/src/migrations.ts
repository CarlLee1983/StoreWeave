import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const identityMigrations: MigrationSet = {
  module: 'identity',
  migrations: [
    sqlMigration(
      '0001_users_and_sessions',
      'expand',
      `
CREATE TABLE IF NOT EXISTS platform_users (
  id             uuid PRIMARY KEY,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  display_name   text NOT NULL,
  role           text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
-- email 以小寫唯一：大小寫不同不能變成兩個帳號。
CREATE UNIQUE INDEX IF NOT EXISTS platform_users_email_key ON platform_users (lower(email));

CREATE TABLE IF NOT EXISTS platform_sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES platform_users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_sessions_token_key ON platform_sessions (token_hash);
CREATE INDEX IF NOT EXISTS platform_sessions_user_idx ON platform_sessions (user_id);
`,
    ),
    sqlMigration('0003_password_resets', 'expand', `
CREATE TABLE IF NOT EXISTS platform_password_resets (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  -- 只存雜湊：明文只出現在信件連結裡，資料庫外洩不等於所有人的帳號被接管。
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_password_resets_user_idx ON platform_password_resets (user_id);
`),
    sqlMigration('0004_identity_tokens', 'expand', `
ALTER TABLE public.platform_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS public.platform_identity_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.platform_users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('password-reset', 'email-verification', 'email-change')),
  -- 只有信箱變更用得到：暫存的新地址以 swe1. 封裝，不是明文。
  data       text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 「作廢這個帳號這個用途尚未使用的 token」是每次簽發都會跑的一句。
CREATE INDEX IF NOT EXISTS platform_identity_tokens_pending_idx
  ON public.platform_identity_tokens (user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_identity_tokens_expiry_idx
  ON public.platform_identity_tokens (expires_at);
`),
    // token 的格式換成 ADR 0038 的簽章值，舊表裡的雜湊沒有對應的新形式可以搬。
    // 未使用的重設連結壽命最長一小時，遷移的代價是「請再點一次忘記密碼」。
    sqlMigration('0005_drop_password_resets', 'contract', `
DROP TABLE IF EXISTS public.platform_password_resets;
`),
    sqlMigration('0006_api_tokens', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_api_tokens (
  id           uuid PRIMARY KEY,
  -- 名字是營運端指認一把 token 的方式。唯一性只加在還活著的列上（見下方索引）：
  -- 兩把同時有效的 "mcp" 沒有人撤銷得掉，但撤銷過的名字必須放得回來，
  -- 不然輪替就得改名，於是輪替不會發生。
  name         text NOT NULL,
  role         text NOT NULL,
  -- 只存雜湊。秘密只在簽發的當下出現一次，系統自己也讀不回來。
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 不可為 NULL：不會過期的 token 就是舊設定檔那把萬能鑰匙（ADR 0043）。
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   text
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_api_tokens_live_name_idx
  ON public.platform_api_tokens (name) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_api_tokens_active_idx
  ON public.platform_api_tokens (expires_at) WHERE revoked_at IS NULL;
`),
    sqlMigration('0007_mfa', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_user_mfa (
  user_id        uuid PRIMARY KEY REFERENCES public.platform_users(id) ON DELETE CASCADE,
  -- TOTP 秘密以 swe1. 封裝：拿到資料庫不等於可以產生別人的六位數。
  secret         text NOT NULL,
  -- 未確認之前不生效，否則掃描失敗的人會把自己鎖在外面。
  confirmed_at   timestamptz,
  -- 用過的時間步。同一組六位數在它的窗口內只能用一次。
  last_time_step bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_mfa_recovery_codes (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.platform_users(id) ON DELETE CASCADE,
  -- 100 bit 隨機值，沒有可猜的結構，因此 sha256 就夠；慢雜湊只會讓復原變慢。
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_mfa_recovery_codes_key
  ON public.platform_mfa_recovery_codes (user_id, code_hash);
`),
    sqlMigration('0008_login_lockout', 'expand', `
-- 連續失敗次數與鎖定時間放在帳號上。不存在的 email 不會有列，所以這裡不是
-- 帳號枚舉管道；針對未知地址的暴力嘗試由 HTTP 層的 per-IP 限流擋。
ALTER TABLE public.platform_users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.platform_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
`),
  ],
};
