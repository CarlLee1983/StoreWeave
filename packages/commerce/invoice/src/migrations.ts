import { sqlMigration, type MigrationSet } from '@storeweave/db';

export const invoiceMigrations: MigrationSet = { module: 'invoice', migrations: [sqlMigration('0001_invoices', 'expand', `
CREATE TABLE IF NOT EXISTS invoice_invoices (
  id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE, order_id uuid NOT NULL UNIQUE, order_number text NOT NULL,
  provider text NOT NULL, reference text NOT NULL UNIQUE, currency text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0), tax_cents integer NOT NULL CHECK (tax_cents >= 0),
  customer jsonb NOT NULL, carrier jsonb NOT NULL, lines jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'issue_failed', 'void_pending', 'voided', 'void_failed')),
  provider_ref text, invoice_number text, invoice_date text,
  issue_attempts integer NOT NULL DEFAULT 0 CHECK (issue_attempts >= 0), void_attempts integer NOT NULL DEFAULT 0 CHECK (void_attempts >= 0),
  last_error text, issued_at timestamptz, voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_invoices_status_idx ON invoice_invoices (status, updated_at DESC);
`)] };
