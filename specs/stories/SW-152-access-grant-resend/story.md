# Story: SW-152 Access Grant Resend Command

## Goal

Give the Reservation module one authorized, auditable operation for rotating and
delivering a Booker Access Grant without returning grant material to an HTTP caller.

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

* Level: high
* Reason: credential rotation and Booker PII

## Scope

### In Scope

* Add a Reservation-owned resend command/capability for an owning Account or
  valid management credential.
* Select the current Booker email, rotate the Grant, request Booking-owned
  notification delivery, and audit through the owned transaction boundary.
* Return only a safe acknowledgement.

### Out of Scope

* HTTP endpoints, Base Notification delivery implementation, new tables, or
  changes to Access Grant cryptography.

## Dependencies

* SW-130, SW-131, SW-134. Complete before SW-136 can satisfy resend AC-001.

## Constraints

* Implement [ticket 108](../../../docs/tickets/108-booking-access-grant-resend-command.md).
* Sol/high design and independent Sol/high review are required.
