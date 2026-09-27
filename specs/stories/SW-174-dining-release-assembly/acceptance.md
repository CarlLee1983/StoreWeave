# SW-174 Acceptance

## Criteria

- [ ] AC-001: Dining builds with its own database/config identity and no Commerce Order or Booking Reservation domain imports.
- [ ] AC-002: Public entrance refuses startup without required retention/rate-limit config or required Theme renderer.
- [ ] AC-003: Roles, grants, routes, worker jobs, Admin, storefront, and CLI projections expose only Dining-approved capabilities.
- [ ] AC-004: Operational guidance specifies positive retention/rate-limit settings, forward-safe rollback, and no reversal of anonymization.

## Evidence to collect

Release definition/projection tests, import-boundary check, and package build/type checks. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
