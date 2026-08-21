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
  ],
};
