# SW-184 Acceptance

## Criteria

- [ ] AC-001: ORD-01 through ORD-19 each have an explicitly numbered passing integration test.
- [ ] AC-002: `make verify` passes from a clean worktree based on the PR target, with frozen dependencies and real PostgreSQL containers.
- [ ] AC-003: Record the tested commit, execution date, environment, commands, and suite results.
- [ ] AC-004: Update WebForge’s known implementation table and deliver fixed-commit evidence.

## Scope

Evidence covers `commerce.order.checkoutCart`, its REST cart checkout and SSR Storefront entry points. Shared line rejection tests also exercise the legacy direct order boundary. This does not certify `POST /api/v1/orders` against the complete checkout contract; its separate follow-up is [issue #125](https://github.com/CarlLee1983/StoreWeave/issues/125).

## Verification record

Pending the complete clean-worktree gate. Focused results in prerequisite Stories are not a substitute for this gate.
