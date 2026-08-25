import { sqlMigration, type MigrationSet } from '@storeweave/db';
export const refundMigrations: MigrationSet = { module: 'refund', migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS refund_refunds (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, customer_id uuid, source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','rma')),
 original_payment_attempt_id uuid NOT NULL, original_payment_attempt_ref text NOT NULL, payment_provider text NOT NULL, payment_provider_ref text NOT NULL,
 amount_cents integer NOT NULL CHECK (amount_cents > 0), currency text NOT NULL, reason text NOT NULL, requested_by_actor_id text NOT NULL,
 status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','succeeded','failed')), attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
 provider_request_ref text NOT NULL UNIQUE, provider_refund_ref text, failure_message text, requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_refunds_order_idx ON refund_refunds (order_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS refund_refunds_status_idx ON refund_refunds (status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS refund_refunds_one_active_direct_order_idx ON refund_refunds (order_id) WHERE source = 'direct' AND status IN ('requested','succeeded');
`),sqlMigration('0002_rma_source','expand',`
ALTER TABLE refund_refunds ADD COLUMN IF NOT EXISTS source_ref uuid;
CREATE UNIQUE INDEX IF NOT EXISTS refund_refunds_one_rma_source_idx ON refund_refunds (source, source_ref) WHERE source = 'rma';
`)] };
