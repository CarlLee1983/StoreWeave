import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const bookingAvailabilityMigrations: MigrationSet = {
  module: 'booking-availability',
  migrations: [sqlMigration('0001_room_night_administration', 'expand', `
CREATE TABLE IF NOT EXISTS public.booking_availability_room_type_prices (
  -- Room Type is owned by booking-property; validate it through the declared capability (ADR 0021).
  room_type_id uuid PRIMARY KEY,
  base_nightly_price_minor integer NOT NULL CHECK (base_nightly_price_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.booking_availability_room_nights (
  room_type_id uuid NOT NULL REFERENCES public.booking_availability_room_type_prices(room_type_id) ON DELETE RESTRICT,
  local_date date NOT NULL,
  sellable_units integer NOT NULL CHECK (sellable_units >= 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  nightly_price_override_minor integer CHECK (nightly_price_override_minor IS NULL OR nightly_price_override_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (room_type_id, local_date),
  CHECK (sellable_units >= reserved_units)
);
`)],
};
