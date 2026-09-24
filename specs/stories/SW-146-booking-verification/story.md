# Story: SW-146 Booking Verification

## Goal

完成 Booking K20 的 repository verification record，將 Spec 0011 §9 的可自動驗證項目、證據位置與仍需外部 release gate 的事項明確連結。

## Context

`make verify` 是完成定義；ECPay staging refund UAT、真實 SMTP 與正式部署不因本機檢查通過而解除。

## Classification

* Security sensitive: no
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

* Level: medium
* Reason: `release-evidence-completeness`

## Scope

### In Scope

* Add/maintain repository docs and verification mapping from every automatable Spec 0011 §9 condition to tests/checks, and record external gates separately.
* Run/document required repository verification after all dependent stories land.

### Out of Scope

* Implementing product behavior, weakening verification, performing external UAT/deploy, or declaring external gates passed.

## Inputs

* Spec 0011 §9, ADR 0052, Booking implementation plan, completed integration/E2E/architecture checks, and `make verify`.

## Outputs

* Auditable Booking verification record with commands, source revision, result, evidence links, and explicit unresolved external gates.

## Rules

* R1: Each §9 condition has an executable evidence reference or an explicitly named external gate; no silent omission.
* R2: `make verify` runs as read-only verification and must pass; a focused green test is insufficient.
* R3: ECPay staging refund UAT, real SMTP, production config/deployment, and operator acceptance remain release gates unless separately evidenced.
* R4: Failure evidence is retained without changing source merely to make checks green.

## Expected Errors

* Missing evidence, stale source revision, failing check, unavailable Docker/testcontainers, or attempted substitution of a mock for external UAT blocks completion and is recorded.

## Provenance

* Issue #46, Spec 0011, ADR 0052, Booking implementation plan K20.

## Dependencies

* SW-145.

## Constraints

* Boundary: repository integration/docs verification only. Do not edit product source, deploy, commit, or publish.
