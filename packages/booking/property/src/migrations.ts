import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const bookingPropertyMigrations: MigrationSet = {
  module: 'booking-property',
  migrations: [sqlMigration('0001_property_and_room_types', 'expand', `
CREATE TABLE IF NOT EXISTS public.booking_property_properties (
  id uuid PRIMARY KEY,
  singleton_slot smallint NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_slot = 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  address jsonb NOT NULL CHECK (jsonb_typeof(address) = 'object'),
  timezone text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  check_in_time text NOT NULL CHECK (check_in_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check_out_time text NOT NULL CHECK (check_out_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  default_policy jsonb NOT NULL CHECK (jsonb_typeof(default_policy) = 'object'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (check_in_time <> check_out_time)
);

CREATE TABLE IF NOT EXISTS public.booking_property_room_types (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.booking_property_properties(id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,49}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  max_occupancy_per_unit integer NOT NULL CHECK (max_occupancy_per_unit BETWEEN 1 AND 32),
  beds jsonb NOT NULL CHECK (jsonb_typeof(beds) = 'array'),
  amenities jsonb NOT NULL CHECK (jsonb_typeof(amenities) = 'array'),
  minimum_stay_nights integer NOT NULL DEFAULT 1 CHECK (minimum_stay_nights BETWEEN 1 AND 30),
  maximum_stay_nights integer CHECK (maximum_stay_nights IS NULL OR maximum_stay_nights BETWEEN minimum_stay_nights AND 30),
  media_asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_property_room_types_active_idx
  ON public.booking_property_room_types (name, id) WHERE status = 'active';
`), sqlMigration('0002_active_room_type_media_lookup', 'expand', `
CREATE INDEX IF NOT EXISTS booking_property_room_types_active_media_idx
  ON public.booking_property_room_types (media_asset_id) WHERE status = 'active';
`)],
};
