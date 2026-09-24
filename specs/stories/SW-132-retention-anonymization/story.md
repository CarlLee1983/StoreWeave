# Story: SW-132 Retention Anonymization

## Goal

Anonymize expired-retention Booker and Guest personal data while preserving required financial and audit evidence.

## Context

B14 makes the Booking retention policy operational in the Reservation-owned data boundary.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes, Booking database only if needed
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: privacy deletion and audit retention

## Scope

### In Scope

* Add required retention-policy validation, scheduled anonymization job, and auditable redaction outcome in `packages/booking/reservation`.

### Out of Scope

* Global Account deletion, Payment Provider data deletion, notification content, and external legal-policy selection.

## Inputs

* Booking Reservation policy `{ reservationPiiRetentionDays }`, frozen Property-local stay-end date, Reservation PII, payment/refund facts, and audit records.

## Outputs

* Idempotently anonymized Booker/Guest PII, unlinked Reservation Account ownership, revoked Reservation management access, and retained lifecycle, necessary financial, and audit evidence.

## Rules

* R1: Booking configuration must provide a positive whole number of retention days; no legal duration is selected or defaulted here. The first Property-local date on or after `checkOutLocalDate + reservationPiiRetentionDays` is eligible.
* R2: Eligibility uses the Reservation's frozen Quote `propertyTimeZone` and database transaction time. It does not query mutable Property data or trust a caller-supplied timestamp.
* R3: Anonymization NULLs Booker name/email/phone, primary Guest name, and accommodation notes; it also clears the Reservation's Account link and Access Grant/management credential state. Global Account data is untouched.
* R4: A persisted anonymization marker is terminal. Claims, Grant issuance/redemption/authorization, and PII updates cannot recreate the link, credentials, or personal fields.
* R5: Do not erase Reservation lifecycle, dates, frozen price/policy facts, payment/refund evidence, or audit records. Record the one-time redaction outcome without any prior PII or credentials.
* R6: Re-running anonymization is safe. Each job processes one bounded batch; if more Reservation rows remain, it enqueues a cursor continuation in the same transaction with stable run lineage and idempotency. Every scheduled run eventually drains its cursor chain; retries do not duplicate redaction audits or restore PII.

## Expected Errors

* Reject missing/invalid policy before module registration; skip ineligible Reservations without mutation. Invalid stored stay dates/timezones fail closed for that row without changing its PII.

## Dependencies

* SW-131 Managed Access Claim.

## Constraints

* Boundary: `packages/booking/reservation` only, with story/acceptance and existing test directories as evidence. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. This Story does not decide legal retention duration, alter Base Account data, or delete provider-side data. Package support is delivered here; Booking release config will compose and supply the required policy in SW-138.
