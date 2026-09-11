import { sqlMigration, type MigrationSet } from '@storeweave/db';

/**
 * 檔案處理申請只擁有這一張表。`storage_object_id` 指向 platform storage 的物件，
 * 但不加外鍵：跨模組參照不加外鍵（ADR 0021），物件的生命週期由本模組的清理工作負責。
 */
export const fileRequestMigrations: MigrationSet = {
  module: 'file-requests',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.file_requests_records (
  id                uuid PRIMARY KEY,
  owner_actor_id    text NOT NULL,
  owner_name        text,
  title             text NOT NULL,
  storage_object_id uuid NOT NULL UNIQUE,
  filename          text NOT NULL,
  content_type      text NOT NULL,
  byte_size         bigint NOT NULL CHECK (byte_size >= 0),
  status            text NOT NULL CHECK (status IN ('queued', 'ready_for_review', 'approved', 'rejected', 'failed', 'purging')),
  generation        integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  sha256            char(64),
  line_count        integer,
  failure_reason    text,
  review_note       text,
  reviewed_by       text,
  submitted_at      timestamptz NOT NULL,
  analyzed_at       timestamptz,
  decided_at        timestamptz,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS file_requests_records_owner_idx
  ON public.file_requests_records (owner_actor_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS file_requests_records_status_idx
  ON public.file_requests_records (status, updated_at);
`)],
};
