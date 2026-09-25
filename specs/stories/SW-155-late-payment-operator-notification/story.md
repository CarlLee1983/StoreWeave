# Story: SW-155 Late Payment Operator Notification

## Goal

讓 `booking-reservation` 在首次確認 Late Payment 時建立獨立、可追蹤且可重試的營運通知，不把先前的取消通知或退款查詢誤當成通知。

## Context

Spec 0011 §9(9) 要求 Excess Payment 可追蹤並退款；§9(10) 另外要求 Late Payment 有全額退款與營運通知。SW-145 E2E 複核證明原有程式只留下 Late Payment、退款及 Admin 可查證據；原有通知種類僅有 confirmed、cancelled、payment-expiring。SW-145 AC-003 的未完成部分是 Late 專屬營運通知，不推定 Excess 也須發通知。

## Classification

* Security sensitive: yes
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: Late Payment financial evidence, notification routing and persistent link migration

## Scope

### In Scope

* In `packages/booking/reservation`, publish a Late Payment event on the first persisted `late` success transition, whether it comes from a verified callback or a Provider initiation result after cancellation/expiry. Create its required full-refund header in the same transaction.
* Add a Booking-owned operator notification kind, template, durable link correlated to the specific Attempt and refund, safe mapping/delivery failure evidence, and an optional validated operator recipient input for the module. Revalidate that Attempt and refund before materialization.
* Add only the Booking notification schema/migration changes needed for the new kind, template and Attempt/refund correlation, with focused PostgreSQL initiation, callback, replay, race, failure and retention tests.
* Provide a bounded, idempotent Booking-owned reconciliation path for preexisting persisted Late Attempts with refunds but no alert. It only creates missing alert evidence; it never retries a charge or refund.

### Out of Scope

* Booking Release configuration/wiring (SW-156), Base Notification delivery, SMTP, Admin/HTTP redesign, payment/refund state machine changes, Commerce, and SW-145 E2E closure.

## Inputs

* Verified callback outcome, immutable Payment Attempt Late classification, required refund evidence, existing Booking event/outbox mapping, and Base Notification capability.
* Optional operator recipient supplied by the Release. SW-156 makes that recipient required in Booking configuration.

## Outputs

* One Late Payment-specific operator notification request/link per Attempt's first persisted `late` classification, correlated to Reservation, Payment Attempt and refund, or safe failure evidence when materialization cannot complete.

## Rules

* R1: Initiation/callback replay or competing outcomes cannot create a second Late notification for the same successful Attempt. For live payments, record a stable Attempt-derived event/reference on the first `late` transition. Historical reconciliation uses the same deterministic Attempt-derived identity without pretending to repeat that transition. Two Late Attempts on one Reservation retain distinct links and refund correlations.
* R2: Notification processing is asynchronous. Missing recipient and repairable mapping failure leave a durable retryable link/job; invalid or stale events may be terminal with safe evidence. Base delivery failure retains its actual retry, dead-letter or terminal status. None of these failures roll back or revive Reservation state, Room Nights, Late classification or its full refund. Existing `platform.jobs.retryJob` or outbox redrive must be proven to retry the same event after repair without a duplicate request, including after automatic attempts are exhausted.
* R2a: Base binds a request to an immutable recipient. A later correction of a syntactically valid but rejected/wrong mailbox does not retarget an existing request or reuse its reference with changed recipient. Keep the failed delivery visible for explicit operator reconciliation; do not mark it delivered or silently send a second alert. This Story does not add a Base resend contract.
* R3: Send to the validated operator recipient only. No Booker recipient, Access Grant, management credential, raw provider payload/message or unnecessary Booker/Guest personal data enters the operator alert, stored link or log.
* R4: Materialization rechecks the named Attempt's `late` classification and linked refund. An earlier cancellation notification cannot satisfy this event's evidence.
* R5: Retention may remove Booker/Guest personal data without breaking the Attempt, refund, alert correlation and necessary audit evidence.
* R6: A bounded reconciliation run finds historical `late` Attempts with required refunds and no Late alert, then creates one alert per Attempt after a recipient is configured using the same deterministic event identity as the live path. Its cutoff/cursor and replay evidence are recorded; ordinary callback replay does not backfill unrelated rows.

## Expected Errors

* Missing/invalid operator recipient, duplicate/replayed initiation or callback, missing or mismatched Attempt/refund, Base mapping/delivery failure, exhausted retry, wrong mailbox and stale event leave safe, distinguishable evidence without duplicate alerts or financial-state rollback. Disabled mail or permanent delivery failure remains visible; this Story does not promise Base will deliver it automatically.

## Provenance

* Spec 0011 §9(10), SW-145 AC-003 and merged PR #106; SW-134 Booking Notifications, SW-129 Reservation Refunds, ADR 0052. SW-145 AC-003 uses combined Late/Excess wording; Spec 0011 §9(9) requires the Excess refund, while §9(10) additionally requires the Late operator notification.

## Dependencies

* Existing SW-128, SW-129, SW-134 and SW-154 capabilities. SW-156 depends on this Story; SW-145 AC-003 needs both Stories plus exact-kind E2E evidence.

## Constraints

* Boundary: `packages/booking/reservation` and its focused tests only. Sol/high design analysis and independent Sol/high review are required before implementation.
* Migration is forward additive. Once new notification-kind rows exist, older readers may reject them; after real data, rollback requires a compatible reader or forward correction, not an assumed down migration.
* The optional-recipient intermediate version is a buildable checkpoint, not a deployable completion of Spec 0011 §9(10). Do not deploy SW-155 alone. SW-156 must run the defined retry/reconciliation path if an intermediate environment processed Late Payments. Preexisting Late rows are included rather than silently excluded.

## Policy decision

* On 2026-09-25, the user chose the dedicated Booking operator-alert mailbox/alias policy in SW-156. The Release supplies `booking.operatorAlertEmail`; missing or invalid configuration prevents Booking startup. This resolves the recipient-policy question only.
* On 2026-09-25, the user authorized execution of these Stories, then authorized a PR. The Authority block permits implementation, additive migration, commit and push for this PR; deployment remains unauthorized.
