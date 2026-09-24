# Story: SW-154 Operator Reservation Read

## Goal

由 `booking-reservation` 提供受權限保護、資料最小化的 operator Reservation 列表、詳情與付款證據 Query，供 SW-137 HTTP 與 SW-142 Admin 使用。

## Context

SW-137 限於 HTTP adapter，不能直接查 Reservation 表或把 Account／management credential 的自助讀取 Query 當 operator 權限。現有退款及通知證據 Query 亦須在對外接線前收斂 provider 自由文字與 actor 邊界。

## Classification

* Security sensitive: yes
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes
* commit: no
* push: no
* deploy: no

## Risk

* Level: high
* Reason: `operator-reservation-pii-and-payment-evidence`

## Scope

### In Scope

* Add distinct operator-read permission and explicit Reservation list/detail/payment-attempt evidence Query descriptors and handlers.
* Keep list pagination bounded and deterministic; provide only operator-required detail and correlation evidence.
* Harden the existing refund evidence Query's operator actor check and outward DTO, and project the existing notification evidence Query to an operator-safe DTO, so provider free text does not pass through either.
* Add focused real-database authorization, pagination, retention, evidence-redaction and migration tests; add only a justified additive Booking list index.

### Out of Scope

* HTTP or Admin routes/UI, generic Query exposure, Reservation state changes, payment/refund processing, provider ABI, Commerce, or new persistent payment evidence fields.

## Inputs

* Existing Reservation schema/repository and Account/management Query boundaries; existing refund and notification evidence Queries; QueryBus authorization contract; SW-137/SW-142 operator use cases.

## Outputs

* Booking-owned, operator-safe Reservation read capability that SW-137 and SW-142 can consume without direct database access.

## Rules

* R1: QueryBus permission and handler both require an authorized human operator; bearer/service/anonymous actors do not gain Reservation PII by carrying a permission string.
* R2: List supports bounded `limit`/`offset`, stable `(createdAt DESC, id DESC)` ordering and limited status, Room Type, and local check-in date filters. List rows omit contact fields, notes, credentials and raw provider data.
* R3: Detail returns a deliberate booking/stay/pricing snapshot and only necessary Booker/Guest fields; after retention anonymization, erased fields remain null.
* R4: Payment attempts are bounded and correlated to the Reservation with status, Late/Excess classification, references, amount/currency and timestamps, but no raw callback, instructions or provider message.
* R5: Refund evidence Query uses the same human-operator guard and a safe outward DTO, omitting freeform `failureMessage`. Notification evidence Query omits freeform delivery `lastError` from its outward DTO. Persisted records, Base delivery and refund command behavior remain unchanged.
* R6: Every Reservation-scoped operator evidence Query distinguishes an unknown parent Reservation from an existing Reservation with no evidence; the first is not-found, the second returns an empty page.

## Expected Errors

* Missing permission, non-human actor, unknown Reservation, invalid UUID/filter/range/pagination and attempts to access anonymized PII are rejected or redacted safely without disclosing another Reservation.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18/K19; [ticket 112](../../../docs/tickets/112-booking-operator-reservation-read-capability.md).

## Dependencies

* Existing Booking Reservation schema, payment/refund/notification evidence and retention capabilities; this Story precedes SW-137 and SW-142.

## Constraints

* Boundary: `packages/booking/reservation` read model, Query declarations, repository, necessary additive migration, and focused tests only. No HTTP/Admin adapter work.
* Sol/high design analysis and independent Sol/high security review are required because this is a financial/PII read boundary.
