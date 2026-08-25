import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { InvoiceCarrier, InvoiceIssueInput } from '@storeweave/extension-sdk';

/** Durable audit record for one sale's B2C invoice lifecycle. */
export const invoices = pgTable('invoice_invoices', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull().unique(),
  orderId: uuid('order_id').notNull().unique(),
  orderNumber: text('order_number').notNull(),
  provider: text('provider').notNull(),
  reference: text('reference').notNull().unique(),
  currency: text('currency').notNull(),
  amountCents: integer('amount_cents').notNull(),
  taxCents: integer('tax_cents').notNull(),
  customer: jsonb('customer').$type<InvoiceIssueInput['customer']>().notNull(),
  carrier: jsonb('carrier').$type<InvoiceCarrier>().notNull(),
  lines: jsonb('lines').$type<InvoiceIssueInput['lines']>().notNull(),
  status: text('status').notNull().default('pending'),
  providerRef: text('provider_ref'),
  invoiceNumber: text('invoice_number'),
  invoiceDate: text('invoice_date'),
  issueAttempts: integer('issue_attempts').notNull().default(0),
  voidAttempts: integer('void_attempts').notNull().default(0),
  lastError: text('last_error'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InvoiceRow = typeof invoices.$inferSelect;
