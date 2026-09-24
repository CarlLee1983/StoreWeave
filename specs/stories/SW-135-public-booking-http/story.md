# Story: SW-135 Public Booking HTTP

## Goal

提供 Booking storefront 的明確 HTTP adapter，將瀏覽、搜尋、Quote、建立 Reservation 與付款啟動轉為 Booking Command／Query。

## Context

這是 K18 的 public HTTP contribution；REST 只能公開明確 Booking 端點，不得成為任意 Command 的通用入口。

## Classification

* Security sensitive: yes
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes — authorized additive Reservation checkout-credential state
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: `anonymous-reservation-authorization`

## Scope

### In Scope

* Add Booking public HTTP controller/adapter contribution and DTO validation for public browse/search, Quote, Reservation creation, and payment initiation.
* Map domain outcomes to stable HTTP responses without exposing provider, token, or persistence details.
* **Authorized scope expansion:** add the smallest Reservation-owned checkout-access slice required to authorize anonymous payment initiation securely: hash-only credential persistence, deterministic opaque bearer derivation, payment-command authorization, and terminal revocation. This exception supersedes the original HTTP-only/no-migration boundary.

### Out of Scope

* Access Grant redemption, management cookie/session, Account claim, Reservation update/cancellation, provider callback, Admin routes, Theme rendering, or generic command exposure.

## Inputs

* `booking-property`, `booking-availability`, and `booking-reservation` public capabilities.
* Booking Release server projection and public Booking page/API contract.

## Outputs

* A server-only public Booking HTTP contribution with documented browse/search, Quote, Reservation, and payment-initiation routes and validated DTOs.

## Rules

* R1: A Quote never reserves Room Night; creation rechecks Quote, policy, and availability in the domain transaction.
* R2: Payment initiation passes only the authorized Reservation/payment input to its capability and exposes no provider secret or persistence detail.
* R3: Reservation number plus Email is never authorization; management-session behavior belongs to SW-136.
* R4: Public routes do not expose Account claim, Booker/Guest update, cancellation, Access Grant redemption, or callback behavior.
* R5: The create Command output, idempotency response, audit records, logs, and Reservation persistence never contain a raw checkout credential. The trusted adapter obtains it only after a successful create/replay and marks the response `Cache-Control: no-store`.
* R6: Checkout authorization is Reservation-owned. A `brc1` bearer is deterministically HMAC-derived from Reservation ID, a stored nonce, and its original payment expiry; only key id, nonce, SHA-256 verifier, expiry, and revocation state persist.
* R7: Authorization happens inside the payment-start transaction before method/status lookup. Missing, malformed, expired, revoked, cross-Reservation, and nonexistent-Reservation credentials produce the same 401 without an Attempt or other state drift.
* R8: The checkout credential expires with the initial payment window and is atomically revoked on confirmation, cancellation, expiry, and PII anonymization. Existing pending Reservations are not backfilled because no safe credential delivery channel exists.

## Expected Errors

* Invalid dates, guest counts, room counts, or date ranges are rejected before persistence.
* Changed Quote/policy returns a replacement Quote; unavailable nights return a recognizable unavailable result.
* Missing/invalid public request data and unauthorized payment initiation are rejected without revealing protected Reservation data.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18.

## Dependencies

* SW-106, SW-124, SW-127.

## Constraints

* Boundary: Booking public HTTP contribution plus the explicitly authorized Reservation checkout-access data and command slice. Browser code must not import Nest, DB, provider, or worker code.
* Additive migration only; no dependency, product-id branch, or Commerce implementation import.
* External payment-provider UAT remains a release gate and is pending; no provider secret is added to this story.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is a public Reservation/payment API boundary.
