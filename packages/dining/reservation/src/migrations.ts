import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const diningReservationMigrations: MigrationSet = {
  module: 'dining-reservation',
  migrations: [sqlMigration('0001_settings_schedule_snapshots', 'expand', `
CREATE TABLE IF NOT EXISTS public.dining_reservation_venues (
  id uuid PRIMARY KEY,
  singleton_slot smallint NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_slot = 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
  occupancy_minutes integer NOT NULL DEFAULT 90 CHECK (occupancy_minutes BETWEEN 1 AND 1440),
  min_advance_minutes integer NOT NULL DEFAULT 60 CHECK (min_advance_minutes BETWEEN 1 AND 525600),
  max_advance_days integer NOT NULL DEFAULT 30 CHECK (max_advance_days BETWEEN 1 AND 365),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (min_advance_minutes <= max_advance_days * 1440)
);

CREATE TABLE IF NOT EXISTS public.dining_reservation_table_types (
  id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES public.dining_reservation_venues(id),
  capacity integer NOT NULL UNIQUE CHECK (capacity BETWEEN 1 AND 1000),
  table_count integer NOT NULL CHECK (table_count BETWEEN 0 AND 10000),
  active smallint NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (active = 1 OR table_count = 0)
);

CREATE TABLE IF NOT EXISTS public.dining_reservation_weekly_starts (
  venue_id uuid NOT NULL REFERENCES public.dining_reservation_venues(id),
  weekday smallint PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  start_times jsonb NOT NULL CHECK (jsonb_typeof(start_times) = 'array')
);

CREATE TABLE IF NOT EXISTS public.dining_reservation_date_overrides (
  venue_id uuid NOT NULL REFERENCES public.dining_reservation_venues(id),
  start_date date PRIMARY KEY,
  start_times jsonb NOT NULL CHECK (jsonb_typeof(start_times) = 'array')
);

CREATE TABLE IF NOT EXISTS public.dining_reservation_request_snapshots (
  id uuid PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES public.dining_reservation_venues(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL CHECK (end_at > start_at),
  start_date date NOT NULL,
  start_time text NOT NULL CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text NOT NULL,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 1000),
  occupancy_minutes integer NOT NULL CHECK (occupancy_minutes BETWEEN 1 AND 1440),
  min_advance_minutes integer NOT NULL CHECK (min_advance_minutes > 0),
  max_advance_days integer NOT NULL CHECK (max_advance_days > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

-- All request writes and timezone edits serialize on the one venue row. This
-- protects the first request against a concurrent timezone change, including
-- writes made outside the module's transaction-scoped insert method.
CREATE OR REPLACE FUNCTION public.dining_reservation_lock_snapshot_venue()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public.dining_reservation_venues WHERE id = NEW.venue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dining venue is missing' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dining_reservation_snapshot_venue_lock
  BEFORE INSERT ON public.dining_reservation_request_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.dining_reservation_lock_snapshot_venue();

CREATE OR REPLACE FUNCTION public.dining_reservation_guard_venue_timezone()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.timezone IS DISTINCT FROM OLD.timezone AND EXISTS (
    SELECT 1 FROM public.dining_reservation_request_snapshots WHERE venue_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Dining timezone is locked after the first request'
      USING ERRCODE = '23514', CONSTRAINT = 'dining_reservation_timezone_locked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dining_reservation_timezone_guard
  BEFORE UPDATE OF timezone ON public.dining_reservation_venues
  FOR EACH ROW EXECUTE FUNCTION public.dining_reservation_guard_venue_timezone();

CREATE OR REPLACE FUNCTION public.dining_reservation_immutable_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dining request snapshots are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'dining_reservation_snapshot_immutable';
END;
$$;
CREATE TRIGGER dining_reservation_snapshot_immutable
  BEFORE UPDATE OR DELETE ON public.dining_reservation_request_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.dining_reservation_immutable_snapshot();
`), sqlMigration('0002_capacity_commitments', 'expand', `
CREATE TABLE IF NOT EXISTS public.dining_reservation_capacity_commitments (
  request_id uuid PRIMARY KEY REFERENCES public.dining_reservation_request_snapshots(id),
  table_type_id uuid NOT NULL REFERENCES public.dining_reservation_table_types(id),
  table_type_capacity integer NOT NULL CHECK (table_type_capacity BETWEEN 1 AND 1000),
  accepted_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  CHECK (cancelled_at IS NULL OR cancelled_at >= accepted_at)
);
CREATE INDEX IF NOT EXISTS dining_reservation_commitments_active_type_idx
  ON public.dining_reservation_capacity_commitments (table_type_id)
  WHERE cancelled_at IS NULL;
`)],
};
