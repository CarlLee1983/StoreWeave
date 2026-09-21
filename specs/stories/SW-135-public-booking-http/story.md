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
* migration: no
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

## Expected Errors

* Invalid dates, guest counts, room counts, or date ranges are rejected before persistence.
* Changed Quote/policy returns a replacement Quote; unavailable nights return a recognizable unavailable result.
* Missing/invalid public request data and unauthorized payment initiation are rejected without revealing protected Reservation data.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18.

## Dependencies

* SW-106, SW-124, SW-127.

## Constraints

* Boundary: Booking public HTTP adapter package only. Browser code must not import Nest, DB, provider, or worker code.
* No migration, dependency, product-id branch, or Commerce implementation import.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is a public Reservation/payment API boundary.
