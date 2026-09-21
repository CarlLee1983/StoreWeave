import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const bookingReservationMigrations: MigrationSet = {
  module: 'booking-reservation',
  migrations: [sqlMigration('0001_reservations', 'expand', `
CREATE TABLE IF NOT EXISTS public.booking_reservation_reservations (
  id uuid PRIMARY KEY,
  room_type_id uuid NOT NULL,
  check_in_local_date date NOT NULL,
  check_out_local_date date NOT NULL,
  room_count integer NOT NULL CHECK (room_count > 0),
  adults integer NOT NULL CHECK (adults >= 0),
  children integer NOT NULL CHECK (children >= 0),
  booker_name text NOT NULL CHECK (length(booker_name) BETWEEN 1 AND 160),
  booker_email text NOT NULL CHECK (length(booker_email) BETWEEN 3 AND 320),
  booker_phone text NOT NULL CHECK (length(booker_phone) BETWEEN 1 AND 40),
  primary_guest_name text NOT NULL CHECK (length(primary_guest_name) BETWEEN 1 AND 160),
  accommodation_notes text CHECK (accommodation_notes IS NULL OR length(accommodation_notes) <= 2000),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'confirmed', 'expired', 'cancelled')),
  payment_expires_at timestamptz NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  nightly_prices jsonb NOT NULL CHECK (jsonb_typeof(nightly_prices) = 'array'),
  cancellation_policy jsonb NOT NULL CHECK (jsonb_typeof(cancellation_policy) = 'object'),
  quote_fingerprint text NOT NULL CHECK (quote_fingerprint ~ '^booking-quote-v1:[a-z][a-z0-9-]{0,63}:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
CHECK (check_out_local_date > check_in_local_date)
);
`), sqlMigration('0002_reservation_access', 'expand', `
ALTER TABLE public.booking_reservation_reservations
  ADD COLUMN IF NOT EXISTS access_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS access_grant_nonce uuid,
  ADD COLUMN IF NOT EXISTS access_grant_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS access_grant_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS management_token_hash text;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_access_generation_check CHECK (access_generation >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_access_grant_pair_check
      CHECK ((access_grant_nonce IS NULL) = (access_grant_expires_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_access_grant_used_check
      CHECK (access_grant_used_at IS NULL OR access_grant_nonce IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_management_token_hash_check
      CHECK (management_token_hash IS NULL OR (access_grant_used_at IS NOT NULL AND management_token_hash ~ '^[0-9a-f]{64}$'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`), sqlMigration('0003_reservation_account_claim', 'expand', `
ALTER TABLE public.booking_reservation_reservations
  ADD COLUMN IF NOT EXISTS owner_account_id uuid;

CREATE INDEX IF NOT EXISTS booking_reservation_owner_account_idx
  ON public.booking_reservation_reservations (owner_account_id);
`), sqlMigration('0004_reservation_pii_retention', 'expand', `
ALTER TABLE public.booking_reservation_reservations
  ALTER COLUMN booker_name DROP NOT NULL,
  ALTER COLUMN booker_email DROP NOT NULL,
  ALTER COLUMN booker_phone DROP NOT NULL,
  ALTER COLUMN primary_guest_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS pii_anonymized_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_anonymized_state_check CHECK (
      pii_anonymized_at IS NULL OR (
        booker_name IS NULL AND booker_email IS NULL AND booker_phone IS NULL
        AND primary_guest_name IS NULL AND accommodation_notes IS NULL
        AND owner_account_id IS NULL AND access_generation = 0
        AND access_grant_nonce IS NULL AND access_grant_expires_at IS NULL
        AND access_grant_used_at IS NULL AND management_token_hash IS NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS booking_reservation_retention_candidate_idx
  ON public.booking_reservation_reservations (id)
  WHERE pii_anonymized_at IS NULL;
`), sqlMigration('0005_reservation_pii_marker_terminal', 'expand', `
CREATE OR REPLACE FUNCTION public.reject_booking_reservation_pii_marker_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.pii_anonymized_at IS NOT NULL
    AND NEW.pii_anonymized_at IS DISTINCT FROM OLD.pii_anonymized_at THEN
    RAISE EXCEPTION 'Reservation PII anonymization marker is terminal'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reservation_pii_marker_terminal';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_reservation_pii_marker_terminal
  ON public.booking_reservation_reservations;
CREATE TRIGGER booking_reservation_pii_marker_terminal
  BEFORE UPDATE OF pii_anonymized_at ON public.booking_reservation_reservations
  FOR EACH ROW EXECUTE FUNCTION public.reject_booking_reservation_pii_marker_rewrite();
`)],
};
