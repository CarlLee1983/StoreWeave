import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const notesMigrations: MigrationSet = {
  module: 'notes',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.notes_entries (
  id uuid PRIMARY KEY,
  owner_actor_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_entries_owner_idx ON public.notes_entries (owner_actor_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_entries_public_idx ON public.notes_entries (status, updated_at DESC);
`)],
};
