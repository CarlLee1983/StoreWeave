# Story: SW-156 Booking Operator Alert Recipient

## Goal

讓 Booking Release 以明確、必填的營運信箱設定接上 SW-155 的 Late Payment 通知能力，並拒絕沒有有效收件者的啟動。

## Context

Base Notification 需要具體 Email 或使用者 ID；原有 Booking 沒有營運收件者契約。Site 的 contact Email 是網站聯絡表單用途且可缺，不能推定為財務告警信箱。SW-155 先在 Reservation 邊界建立可驗證的可選輸入；此 Story 在 Release 邊界完成接線。

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
* Reason: financial-alert recipient policy and Booking startup contract

## Scope

### In Scope

* In `packages/releases/booking`, declare a dedicated required `booking.operatorAlertEmail` configuration field and pass its validated value to SW-155's Reservation input.
* Update the Release's build-only config, example/fixture configuration and focused startup/config tests. Reject absent or invalid values before serving or processing Booking work.
* Verify SW-155's bounded historical reconciliation and the existing dead-job/outbox retry path after a valid recipient is configured, without duplicate operator requests; record the exact job/event identity and operational replay step.

### Out of Scope

* Booking Reservation notification implementation (SW-155), Base Notification/SMTP implementation, Site contact Email reuse, operator-directory broadcast, actual mailbox provisioning, real SMTP UAT, deployment, and SW-145 E2E closure.

## Inputs

* SW-155's validated optional operator recipient input and retryable evidence; Booking config projection and Release module composition.

## Outputs

* A selected Booking Release whose Reservation module has one explicit operator alert recipient and whose startup fails visibly without one.

## Rules

* R1: `booking.operatorAlertEmail` is a dedicated operator-controlled mailbox or alias, not Booker Email, callback data, Site contact Email or an inferred set of admin users.
* R2: Missing/invalid recipient fails configuration/bootstrap before HTTP or Worker processing; no silent notification skip or fallback recipient.
* R3: The same logical config and recipient reach server and worker target projections without importing executable code across targets or changing Commerce/Base configuration.
* R4: Reconciliation of SW-155 retryable or historical missing alerts after configuration yields one Late-specific operator request per Attempt and leaves refund/Reservation evidence intact. Base terminal delivery status is reported, not silently counted as delivered. Changing this config does not retarget Base's immutable requests already addressed to a wrong mailbox; those require explicit operational reconciliation.

## Expected Errors

* Missing/invalid Email, unavailable recipient setting, stale/replayed retryable alert and failed Base delivery fail visibly without fallback routing or duplicate financial actions. A corrected mailbox applies to new or not-yet-materialized alerts, not an existing Base request with an immutable recipient.

## Provenance

* Spec 0011 §9(10), SW-145 AC-003 and merged PR #106; SW-155 Late Payment Operator Notification, ADR 0052.

## Dependencies

* SW-155. SW-145 AC-003 remains open until this Story and exact-kind E2E evidence pass; SW-146 verification depends on that closure.

## Constraints

* Boundary: `packages/releases/booking` config/composition and its focused examples/tests only. No Booking Reservation, Platform, Base, Commerce or Admin implementation edits.
* No DB migration. Keep one Booking config source and target projections; do not add a second environment-only recipient override. If SW-155 generated dead jobs or an environment already has historical Late rows, execute its bounded retry/reconciliation step before claiming SW-145 AC-003.
* Sol/high design analysis and independent Sol/high review are required because this selects the destination for financial alerts. ECPay refund UAT, real SMTP and deployment remain separate release gates.

## Policy decision

* On 2026-09-25, the user chose a dedicated configured Booking operator-alert mailbox/alias and rejection of Booking startup when it is absent or invalid. No actual Email address belongs in this Story.
* On 2026-09-25, the user authorized execution of these Stories, then authorized a PR. The Authority block permits implementation, commit and push for this PR; deployment remains unauthorized.
