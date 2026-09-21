# Story: SW-142 Reservation Admin

## Goal

提供 `booking-reservation` 的 Admin contribution，讓 operator 查閱 Reservation、取消並指定退款、且看見退款、通知、Late Payment 與 Excess Payment 的處理證據。

## Context

Reservation 擁有付款嘗試、取消、退款與營運通知 mapping；退款失敗不得回復 Reservation 或靜默消失。

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
* Reason: `financial-operator-action-and-pii`

## Scope

### In Scope

* Add Reservation list/detail, operator cancellation/refund action, payment/refund/notification outcome display, permissions, navigation, and Admin UI contributions.

### Out of Scope

* Reservation state/refund implementation, provider adapter, public Booker management routes, retention job, or accounting.

## Inputs

* `booking-reservation` operator commands/queries and Admin composition contract.

## Outputs

* Authorized Booking Admin Reservation operations and evidence views.

## Rules

* R1: Operator cancellation is whole-Reservation and records an audit reason plus refund amount from zero through amount received.
* R2: Refund work remains independent after cancellation; failure never restores room nights or Reservation state.
* R3: Late/Excess payment, refund failure, and notification failure have operator-visible correlation evidence.
* R4: UI redacts credentials and unnecessary PII; route authorization is backend-enforced.

## Expected Errors

* Forbidden operator, missing Reservation, invalid refund amount/reason, state conflict, and unavailable refund action produce safe distinguishable feedback.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K19.

## Dependencies

* SW-134, SW-137, SW-141.

## Constraints

* Boundary: `booking-reservation` Admin contribution only. No provider implementation, direct DB access, or Commerce Order UI.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is an operator financial and PII boundary.
