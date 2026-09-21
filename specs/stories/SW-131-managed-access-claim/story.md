# Story: SW-131 Managed Access Claim

## Goal

Allow a Booker's authenticated Account to explicitly claim a Reservation only through authenticated or valid managed access.

## Context

B13 connects anonymous Reservation ownership to Account without automatic Email matching.

## Classification

* Security sensitive: yes
* Baseline conformance: no
* Task mode: execution

## Authority

* plan: yes
* modify: yes
* add_dependency: no
* migration: yes, Booking database only if needed
* commit: yes
* push: yes
* deploy: no

## Risk

* Level: high
* Reason: account ownership authorization

## Scope

### In Scope

* Add Reservation Account ownership and explicit claim authorization, owner-scoped and management-session reads, plus Booker contact, primary Guest name, and accommodation-notes update commands with audit evidence, in `packages/booking/reservation`.

### Out of Scope

* Session issuance, HTTP authentication adapter, HTTP update endpoints, Access Grant issuance, and Account schema ownership.

## Inputs

* A current authenticated Account Actor from Identity, a valid SW-130 management credential, and the target Reservation.

## Outputs

* Explicit Reservation-to-Account ownership link and owner- or management-session-scoped access decisions.

## Rules

* R1: Initial claim requires both a current authenticated Account Actor and valid SW-130 management authorization for the same Reservation. The anonymous Booker proves management access, then signs in before claiming.
* R2: Derive Account identity only from Identity's authenticated Actor (`user` or `customer` with canonical `user:<uuid>` id); never accept a client-supplied Account id or link by matching Email.
* R3: Owner reads and operations filter by the authenticated Account id. A different Account cannot read or update the Reservation.
* R4: Authorized Bookers may update contact details, primary Guest name, and accommodation notes with audit evidence; dates, Room Type, room count, party counts, and frozen price/policy are immutable.
* R5: A valid management credential can read and update allowed Booker details before or after claim, alongside owner-scoped Account access, for the SW-136 management flow. Management reads validate the credential and fetch the Reservation in one transaction so access rotation cannot race the read.
* R6: Any existing Reservation may be claimed regardless of lifecycle status; only an unowned Reservation may gain an Account link. Retention/anonymization policy is handled by SW-132.

## Expected Errors

* Reject unauthenticated claim, invalid/revoked managed access, cross-Account access, client account-id forgery, Email-only match, and invalid/unauthorized mutable-field updates.

## Dependencies

* SW-130 Reservation Access Grant.

## Constraints

* Boundary: `packages/booking/reservation` only, with evidence in existing test directories. Identity's authenticated `CommandContext.actor` is the Account identity capability; derive its UUID without querying or changing `platform_users`, and do not depend on Commerce Customer data. The management query is the domain seam required by SW-136; its adapter stays outside this Story. Requires Sol/high design analysis and independent Sol/high review. Migrations are additive: before Booking has real data, roll back by returning to the prior program version or discarding the clean Booking database; after data exists, use forward-additive correction and never assume a down migration. Do not change authentication packages.
