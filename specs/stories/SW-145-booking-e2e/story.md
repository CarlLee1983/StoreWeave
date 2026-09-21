# Story: SW-145 Booking E2E

## Goal

建立 Booking Release 的端到端旅程與失敗情境證據，涵蓋搜尋、Quote、占房、付款、管理、取消、退款及關鍵競態結果。

## Context

K20 closure 必須證明 Spec 0011 §9 的 Booking observable behavior；mock 成功不能取代外部 ECPay refund UAT release gate。

## Classification

* Security sensitive: yes
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: `reservation-payment-concurrency`

## Scope

### In Scope

* Add repository Booking E2E fixtures/tests using a clean Booking database and qualified test payment provider for core and failure journeys, including the retention anonymization journey that preserves required payment/refund/audit evidence.

### Out of Scope

* Domain implementation changes, production ECPay/SMTP UAT, deployment, multi-Property/OTA features, or Commerce E2E redesign.

## Inputs

* Completed Booking Release, HTTP/Admin contributions, module capabilities, testcontainers harness, and refund-capable test provider.

## Outputs

* Reproducible end-to-end evidence for Booking success and safety-critical failures.

## Rules

* R1: Two requests for the last Room Night yield exactly one Reservation and one recognizable unavailable result.
* R2: Quote price/policy changes return replacement Quote; unavailable does not create Reservation.
* R3: Callback/cancel/expiry/extension serialize: one winning payment confirms; Late/Excess payments refund and never revive/reoccupy.
* R4: Access Grant is one-time and redirects cleanly; unauthorized management and implicit Account linking fail.
* R5: Cancellation/expiry releases all Room Nights; refund failure is visible and never restores Reservation.
* R6: Retention anonymization removes no-longer-needed Booker/Guest PII after the configured deadline while preserving required payment, refund, and audit evidence.

## Expected Errors

* Invalid request, sold-out night, stale Quote, failed/replayed payment, expired grant, unauthorized claim, cancellation deadline, refund/notification failure, and invalid/early retention anonymization request produce asserted outcomes.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K20.

## Dependencies

* SW-132, SW-144.

## Constraints

* Boundary: repository E2E tests/fixtures only. Do not contact real payment, SMTP, or deployment services; external UAT remains a release gate.
* Sol/high design analysis and independent Sol/high review are required before implementation because this verifies payment, PII retention, and concurrency safety boundaries.
