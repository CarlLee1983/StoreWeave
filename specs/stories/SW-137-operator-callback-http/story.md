# Story: SW-137 Operator Callback HTTP

## Goal

提供 Booking operator 與 Payment Provider callback 的 server HTTP adapter，安全地把 operator Property/Availability/Reservation/refund/evidence 操作及可驗證 provider 結果送入各自 capability。

## Context

付款 callback 與取消、到期、期限延長競爭時由 Reservation 層序列化；HTTP adapter 不得自行改狀態。

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
* Reason: `payment-callback-integrity`

## Scope

### In Scope

* Add explicit operator Property, Availability, Reservation, refund, and evidence HTTP endpoints with backend authorization, plus Booking callback route contribution, provider-result verification handoff, idempotent acknowledgement, and safe operational observability.

### Out of Scope

* Provider ABI/adapter changes, Reservation locking/state transitions, refund implementation, public Booking/management routes, Admin UI, or generic REST-to-Command exposure.

## Inputs

* Domain-neutral Payment Provider callback verifier; Booking Property, Availability, and Reservation operator capabilities; and Booking Reservation payment-result capability.

## Outputs

* A server-only API adapter with explicit operator Property/Availability/Reservation/refund/evidence endpoints and a callback endpoint that resolves by unique provider reference and preserves provider verification evidence.

## Rules

* R1: Only a provider-verifiable result reaches the Reservation capability.
* R2: HTTP does not trust client Reservation identifiers, infer success, or revive expired/cancelled Reservations.
* R3: Repeated callbacks are safe and acknowledge according to the provider contract.
* R4: Logs/evidence contain correlation references, never raw management tokens or unnecessary PII.
* R5: Operator endpoints enforce backend permissions and map only explicitly declared capability operations; no generic REST-to-Command route is permitted.

## Expected Errors

* Invalid signature, unknown reference, malformed callback, unsupported method, and replay have explicit safe handling.
* Late and Excess Payments remain domain outcomes that create traceable refund/notification work, not HTTP success-side state changes.

* Unauthorized operator, unknown operator resource, and invalid operator refund/evidence request receive safe authorization, not-found, or validation outcomes.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18.

## Dependencies

* SW-136, SW-119, SW-121, SW-128, SW-129, SW-134, SW-154.

## Constraints

* Boundary: Booking operator/callback HTTP adapter package only. No provider secret in browser, no generic REST-to-Command route, and no Commerce implementation import.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is an operator/financial public API boundary.
