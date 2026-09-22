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
`), sqlMigration('0006_reservation_payment_attempts', 'expand', `
CREATE TABLE IF NOT EXISTS public.booking_reservation_payment_attempts (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES public.booking_reservation_reservations(id),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 200),
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 100),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'submitted', 'awaiting_payment', 'succeeded', 'failed', 'expired')),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 200),
  action jsonb,
  instructions jsonb,
  expires_at timestamptz NOT NULL,
  failure_reason text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_reservation_payment_attempt_reference_key
  ON public.booking_reservation_payment_attempts (reference);
CREATE UNIQUE INDEX IF NOT EXISTS booking_reservation_payment_attempt_provider_ref_key
  ON public.booking_reservation_payment_attempts (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_reservation_payment_attempt_active_reservation_key
  ON public.booking_reservation_payment_attempts (reservation_id)
  WHERE status IN ('created', 'submitted', 'awaiting_payment');
`), sqlMigration('0007_payment_callback_winner', 'expand', `
ALTER TABLE public.booking_reservation_reservations
  ADD COLUMN IF NOT EXISTS winning_payment_attempt_id uuid;

ALTER TABLE public.booking_reservation_payment_attempts
  ADD COLUMN IF NOT EXISTS success_kind text,
  ADD COLUMN IF NOT EXISTS succeeded_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_payment_attempts
    ADD CONSTRAINT booking_reservation_payment_attempt_success_evidence_check CHECK (
      (status <> 'succeeded' AND success_kind IS NULL AND succeeded_at IS NULL)
      OR (status = 'succeeded' AND success_kind IN ('winning', 'late', 'excess')
          AND succeeded_at IS NOT NULL AND provider_ref IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS booking_reservation_payment_attempt_id_reservation_key
  ON public.booking_reservation_payment_attempts (id, reservation_id);

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_winning_payment_attempt_check
    CHECK (winning_payment_attempt_id IS NULL OR status IN ('confirmed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.booking_reservation_reservations
    ADD CONSTRAINT booking_reservation_winning_payment_attempt_fk
    FOREIGN KEY (winning_payment_attempt_id, id)
    REFERENCES public.booking_reservation_payment_attempts(id, reservation_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.check_booking_reservation_winning_payment_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pointed_attempt public.booking_reservation_payment_attempts;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.winning_payment_attempt_id IS NOT NULL
    AND NEW.winning_payment_attempt_id IS NULL THEN
    RAISE EXCEPTION 'A selected Reservation winner cannot be cleared'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reservation_winning_payment_attempt_integrity';
  END IF;
  IF NEW.winning_payment_attempt_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO pointed_attempt FROM public.booking_reservation_payment_attempts
    WHERE id = NEW.winning_payment_attempt_id AND reservation_id = NEW.id;
  IF pointed_attempt.status <> 'succeeded' OR pointed_attempt.success_kind <> 'winning' THEN
    RAISE EXCEPTION 'Reservation winner must point to its succeeded winning Attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reservation_winning_payment_attempt_integrity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_reservation_winning_payment_attempt_integrity
  ON public.booking_reservation_reservations;
CREATE TRIGGER booking_reservation_winning_payment_attempt_integrity
  BEFORE INSERT OR UPDATE OF winning_payment_attempt_id, status ON public.booking_reservation_reservations
  FOR EACH ROW EXECUTE FUNCTION public.check_booking_reservation_winning_payment_attempt();

CREATE OR REPLACE FUNCTION public.protect_booking_reservation_winning_payment_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.booking_reservation_reservations
    WHERE winning_payment_attempt_id = OLD.id
  ) AND (NEW.status <> 'succeeded' OR NEW.success_kind <> 'winning') THEN
    RAISE EXCEPTION 'A selected Reservation winner must remain a succeeded winning Attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reservation_winning_payment_attempt_integrity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_reservation_winning_payment_attempt_protection
  ON public.booking_reservation_payment_attempts;
CREATE TRIGGER booking_reservation_winning_payment_attempt_protection
  BEFORE UPDATE OF status, success_kind ON public.booking_reservation_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.protect_booking_reservation_winning_payment_attempt();

CREATE OR REPLACE FUNCTION public.require_booking_reservation_winner_pointer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.success_kind = 'winning' AND NOT EXISTS (
    SELECT 1 FROM public.booking_reservation_reservations
    WHERE id = NEW.reservation_id AND winning_payment_attempt_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A winning Attempt must be selected by its Reservation'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reservation_winning_payment_attempt_integrity';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS booking_reservation_winning_attempt_requires_pointer
  ON public.booking_reservation_payment_attempts;
CREATE CONSTRAINT TRIGGER booking_reservation_winning_attempt_requires_pointer
  AFTER INSERT OR UPDATE OF status, success_kind, reservation_id ON public.booking_reservation_payment_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.require_booking_reservation_winner_pointer();

CREATE UNIQUE INDEX IF NOT EXISTS booking_reservation_payment_attempt_winning_reservation_key
  ON public.booking_reservation_payment_attempts (reservation_id)
  WHERE success_kind = 'winning';
`), sqlMigration('0008_winner_pointer_cancelled_state', 'expand', `
ALTER TABLE public.booking_reservation_reservations
  DROP CONSTRAINT IF EXISTS booking_reservation_winning_payment_attempt_check;

ALTER TABLE public.booking_reservation_reservations
  ADD CONSTRAINT booking_reservation_winning_payment_attempt_check
  CHECK (winning_payment_attempt_id IS NULL OR status IN ('confirmed', 'cancelled'));
`), sqlMigration('0009_reservation_refunds', 'expand', `
CREATE TABLE IF NOT EXISTS public.booking_reservation_refunds (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES public.booking_reservation_reservations(id),
  payment_attempt_id uuid NOT NULL REFERENCES public.booking_reservation_payment_attempts(id),
  reason text NOT NULL CHECK (reason IN ('late_payment', 'excess_payment', 'reservation_cancellation')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 200),
  payment_provider_ref text NOT NULL CHECK (length(payment_provider_ref) BETWEEN 1 AND 200),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_request_ref text NOT NULL UNIQUE CHECK (length(provider_request_ref) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  provider_refund_ref text,
  failure_kind text CHECK (failure_kind IS NULL OR failure_kind IN ('rejected', 'unsupported', 'indeterminate')),
  failure_message text,
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (payment_attempt_id)
);
CREATE INDEX IF NOT EXISTS booking_reservation_refund_reservation_idx
  ON public.booking_reservation_refunds (reservation_id, requested_at);

CREATE TABLE IF NOT EXISTS public.booking_reservation_refund_invocations (
  id uuid PRIMARY KEY,
  refund_id uuid NOT NULL REFERENCES public.booking_reservation_refunds(id),
  generation integer NOT NULL CHECK (generation >= 1),
  worker_attempt integer NOT NULL CHECK (worker_attempt >= 1),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected', 'unsupported', 'indeterminate')),
  provider_refund_ref text,
  message text,
  invoked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (refund_id, generation, worker_attempt)
);

-- SW-128 may already have classified a received late/excess payment before
-- this additive migration reaches a Booking database. Backfill a deterministic
-- header per Attempt; the runtime reconciler schedules its provider work.
INSERT INTO public.booking_reservation_refunds (
  id, reservation_id, payment_attempt_id, reason, provider, payment_provider_ref,
  amount_minor, currency, provider_request_ref, status, generation, requested_at, updated_at
)
SELECT
  (substr(md5('booking-reservation-refund:' || a.id::text), 1, 8) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 9, 4) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 13, 4) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 17, 4) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 21, 12))::uuid,
  a.reservation_id, a.id,
  CASE a.success_kind WHEN 'late' THEN 'late_payment' ELSE 'excess_payment' END,
  a.provider, a.provider_ref, a.amount_minor, a.currency,
  'booking-refund:' || (substr(md5('booking-reservation-refund:' || a.id::text), 1, 8) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 9, 4) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 13, 4) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 17, 4) || '-' ||
   substr(md5('booking-reservation-refund:' || a.id::text), 21, 12)),
  'pending', 1, a.succeeded_at, a.succeeded_at
FROM public.booking_reservation_payment_attempts a
WHERE a.status = 'succeeded' AND a.success_kind IN ('late', 'excess') AND a.provider_ref IS NOT NULL
ON CONFLICT (payment_attempt_id) DO NOTHING;

`), sqlMigration('0010_refund_attempt_reservation_integrity', 'expand', `
-- 0007 already supplies the unique (id, reservation_id) parent key. Keep the
-- separately-owned Refund header from ever mixing those two identities.
DO $$ BEGIN
  ALTER TABLE public.booking_reservation_refunds
    ADD CONSTRAINT booking_reservation_refund_attempt_reservation_fk
    FOREIGN KEY (payment_attempt_id, reservation_id)
    REFERENCES public.booking_reservation_payment_attempts(id, reservation_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

`)],
};
