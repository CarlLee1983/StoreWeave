# Story: SW-124 Search and Quote Theme

## Goal

Provide a read-only multi-Room-Type Booking search and Quote journey through Availability-owned storefront pages rendered by the Booking Theme.

## Context

B06 turns Availability results into a Theme journey while keeping calculation in the Availability module.

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
* Reason: public quote presentation

## Scope

### In Scope

* In `packages/booking/availability`, add a search capability/query over active Room Types, two Availability-owned storefront page contracts, and their read-only page producers.
* In `packages/themes/booking-default`, render the declared Booking search and Quote page models.

### Out of Scope

* Reservation creation, atomic fingerprint revalidation with Room Night reservation, persistence, schema/migration changes, and changes to the generic HTTP adapter or Property module.

## Scope Decision

The story was explicitly expanded from Theme-only to include Availability-owned Search/Quote page contracts and producers because the renderer needs those page models. The expansion remains within Availability and the Booking Theme; it does not change the generic HTTP adapter or Kernel.

## Inputs

* Search request: check-in/check-out local dates, guest counts, and room count.
* Quote request: Room Type, the same stay/guest fields, and optional expected fingerprint.
* The existing `booking.property.read.v1` capability and Availability Room Night/Quote data.

## Outputs

* Availability-owned read-only Search and Quote pages at `GET /booking/search` and `GET /booking/quote`.
* Search results in Property Room Type order, each with a server-produced Quote.
* Theme presentation of supplied nightly prices, totals, currency, cancellation policy, fingerprint, refreshed terms, validation, and unavailable outcomes.

## Rules

* R1: Search validates common syntax/static constraints before I/O, reads Property and active Room Types once, validates the Property-local horizon before Availability supply reads, preserves Property order, and excludes only Room-Type-specific stay/occupancy mismatches or unavailable supply.
* R2: A missing base price for an otherwise eligible Room Type is a visible configuration conflict; it is not silently omitted.
* R3: The search page without query fields is an initial form. Tolerant GET input schemas pass raw or partial query strings to the Availability producer; submitted semantic validation failures produce a typed HTTP 400 view, declared as such in the page HTTP contract. Both GET page contracts also declare their normal 200 and `platform-error` responses.
* R4: The Quote page recomputes a read-only current Quote. An omitted or matching expected fingerprint is `current`; a mismatch with an available Quote is `refreshed`; unavailable supply takes precedence over a fingerprint mismatch. Search returns `unavailable` when no eligible available choice remains.
* R5: Refresh is a presentation state only. Fingerprint comparison, freezing terms, and Room Night reservation are not atomic in this story.
* R6: Render supplied Quote terms and fingerprint; never recalculate price, totals, supply, or policy.
* R7: A refreshed Quote is visibly distinct and requires Booker reconfirmation in the next flow.
* R8: Search and Quote pages are public GET pages using query input; Quote identifies the Room Type with `roomTypeId` in the query to keep request identity unambiguous.

## Expected Errors

* Reject missing required renderer declarations at startup. Render only recognized query validation failures as Booking validation views; not-found, conflict, authorization, and internal failures use `platform.error`.

## Dependencies

* SW-120 Booking Property Theme.
* SW-122 Availability Quote.

## Constraints

* Boundary: `packages/booking/availability` and `packages/themes/booking-default` only. Reuse the existing Property read capability; do not change `packages/booking/property`, the generic HTTP adapter, Kernel, Release, or Commerce.
* The Theme artifact must have no runtime imports from Booking implementation or Commerce packages.
* Requires Sol/high design analysis and independent Sol/high review for the public page and Quote presentation contracts.
