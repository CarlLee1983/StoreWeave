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
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_identity_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('password-reset', 'email-verification', 'email-change')),
  -- 只有信箱變更用得到：暫存的新地址以 swe1. 封裝，不是明文。
  data       text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 「作廢這個帳號這個用途尚未使用的 token」是每次簽發都會跑的一句。
CREATE INDEX IF NOT EXISTS platform_identity_tokens_pending_idx
  ON platform_identity_tokens (user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_identity_tokens_expiry_idx
  ON platform_identity_tokens (expires_at);
`),
    // token 的格式換成 ADR 0038 的簽章值，舊表裡的雜湊沒有對應的新形式可以搬。
    // 未使用的重設連結壽命最長一小時，遷移的代價是「請再點一次忘記密碼」。
    sqlMigration('0005_drop_password_resets', 'contract', `
DROP TABLE IF EXISTS platform_password_resets;
`),
    sqlMigration('0006_api_tokens', 'expand', `
CREATE TABLE IF NOT EXISTS platform_api_tokens (
  id           uuid PRIMARY KEY,
  -- 名字是營運端指認一把 token 的方式，因此唯一：兩把叫 "mcp" 的 token 沒有人撤銷得掉。
  name         text NOT NULL UNIQUE,
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
CREATE INDEX IF NOT EXISTS platform_api_tokens_active_idx
  ON platform_api_tokens (expires_at) WHERE revoked_at IS NULL;
`),
  ],
};
