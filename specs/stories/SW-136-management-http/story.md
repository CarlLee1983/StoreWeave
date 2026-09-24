# Story: SW-136 Management HTTP

## Goal

提供受授權 Booker 與 Account 的 Reservation management HTTP adapter，讓聯絡資料更新、明確 Account claim、取消與管理連結重發使用明確端點。

## Context

Spec 0011 要求匿名管理依 management session、Account access 依 ownership，且 Account linkage 必須是重新登入後的明確 claim。

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
* Reason: `reservation-ownership-and-pii`

## Scope

### In Scope

* Add public management endpoints for Access Grant redemption, authorized Reservation read/update, self-service cancellation, Access Grant resend, and explicit Account claim.
* Translate capability outcomes to HTTP status and safe response DTOs.

### Out of Scope

* Grant signing and cookie cryptography implementation, Reservation state implementation, operator/callback HTTP, or account/session platform changes.

## Inputs

* Reservation management and authorization capabilities; authenticated Actor and management-session adapter context.

## Outputs

* A server-only management HTTP contribution with no client-supplied ownership authority, a scoped `HttpOnly`/`Secure`/`SameSite=Strict` management cookie, CSRF protection, and rate limits on management endpoints.

## Rules

* R1: Redemption consumes one signed Access Grant, sets a scoped `HttpOnly`, `Secure`, `SameSite=Strict` management cookie, and returns a 303 redirect to a clean URL.
* R2: Client supplied account id and matching Email never establish ownership.
* R3: Claim requires the currently authenticated Account or a valid management session followed by re-login.
* R4: Self-service cancellation is whole-Reservation only and honors its frozen Cancellation Policy; responses redact credentials and only return authorized Booker/Guest data.
* R5: State-changing management endpoints require CSRF protection and every management endpoint has an explicit rate limit suitable for credential-bearing anonymous access.

## Expected Errors

* Unauthenticated, unauthorized, expired, revoked, replayed, or malformed Grant/management access is rejected.
* CSRF failure and rate-limit exhaustion are rejected without consuming a valid management authorization or disclosing Reservation data.
* Claim conflict, policy deadline, immutable booking facts, and invalid contact update return distinguishable safe errors.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K18.

## Dependencies

* SW-135, SW-130, SW-131, SW-133.

## Constraints

* Boundary: Booking management HTTP adapter package only. No Admin contribution, migration, or Commerce dependency.
* Sol/high design analysis and independent Sol/high review are required before implementation because this is a public credential-bearing API boundary.
