# SW-175 Repository Wiring Acceptance

## Criteria

- [ ] AC-001: Root scripts can select and build Dining for backend, worker, storefront, Admin, and CLI targets without selecting Commerce or Booking domain modules.
- [ ] AC-002: TypeScript, Admin, and Vitest discovery include Dining source and tests; existing Base, Commerce, and Booking gates remain green.
- [ ] AC-003: Deployment examples identify Dining's separate database and required positive retention/source/recipient rate-limit settings and windows.
- [ ] AC-004: `make verify` passes with Dining included; release build selection and startup work against a clean Dining database.

## Evidence to collect

Release build selection, root typechecks, existing release regression, and final boundary/diff review. Record the exact tests, commands, results, and review findings here when this Story is implemented. Do not check a criterion until its observed result passes.
