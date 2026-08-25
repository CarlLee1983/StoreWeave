import { sqlMigration,type MigrationSet } from '@storeweave/db';
export const rmaMigrations:MigrationSet={module:'rma',migrations:[sqlMigration('0001_init','expand',`
CREATE TABLE IF NOT EXISTS rma_cases (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, customer_id uuid NOT NULL, status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','needs_information','approved','rejected','received','refund_pending','refund_failed','completed')),
 resolution text NOT NULL DEFAULT 'refund_and_reorder' CHECK (resolution = 'refund_and_reorder'), reason text NOT NULL, requested_by_actor_id text NOT NULL, staff_note text, refund_id uuid, received_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rma_lines (
 id uuid PRIMARY KEY, rma_id uuid NOT NULL REFERENCES rma_cases(id) ON DELETE CASCADE, order_line_id uuid NOT NULL, product_id uuid NOT NULL, sku text NOT NULL, name text NOT NULL, unit_price_cents integer NOT NULL, line_total_cents integer NOT NULL, discount_cents integer NOT NULL DEFAULT 0, quantity integer NOT NULL CHECK (quantity > 0), disposition text CHECK (disposition IN ('restock','discard')), discard_reason text,
 CHECK ((disposition = 'discard' AND discard_reason IS NOT NULL) OR (disposition IS DISTINCT FROM 'discard'))
);
CREATE INDEX IF NOT EXISTS rma_cases_order_idx ON rma_cases (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rma_cases_customer_idx ON rma_cases (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rma_cases_status_idx ON rma_cases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS rma_lines_order_line_idx ON rma_lines (order_line_id);
`)]};
