# Story: SW-153 Enforce Declared Rate Limits Across Methods

## Goal

Apply an explicit server route `rateLimit` declaration to GET and other HTTP
methods as well as POST, so Booking management reads are throttled.

## Classification

* Security sensitive: yes
* Baseline conformance: yes
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: no
* commit: no
* push: no
* deploy: no

## Risk

* Level: medium
* Reason: shared request admission boundary

## Scope

### In Scope

* Apply each route's existing declared bucket regardless of HTTP method.
* Cover GET throttling and POST regression in focused tests.

### Out of Scope

* Booking controller code, new buckets, threshold changes, or implicit limits
  on routes without a declaration.

## Dependencies

* Existing release-server rate-limit contract. Complete before SW-136 claims
  all management endpoints are throttled.

## Constraints

* Implement [ticket 109](../../../docs/tickets/109-management-get-rate-limit.md).
