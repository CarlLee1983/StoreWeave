# Acceptance Criteria

## Happy Path

* [x] AC-001: Commerce Order initiates providers through the neutral reference/displayReference ABI.
* [x] AC-002: Immediate and deferred payment, verified callback, retry, and refund workflows retain their existing public outcomes.

## Failure Cases

* [x] AC-003: Provider/callback/refund failure paths retain distinguishable, non-success Order results.

## Regression Requirements

* [x] AC-004: No Commerce public Command, Query, Event, URL, data, or `commerce.yaml` contract changes.

## Acceptance Evidence

| AC | Method | Evidence | Expected observation |
| --- | --- | --- | --- |
| `AC-001` | unit + integration | `packages/commerce/order/test/payment-job.test.ts` (4/4), `tests/integration/flow-order-outbox.test.ts` (10/10) | exact neutral input; provider worker calls `initiate`; start-only provider is rejected without fallback |
| `AC-002` | integration + callback regression | `flow-order-outbox` (10/10), `cart-checkout` (12/12), `refund-domain` (4/4), callback controller/HTTP unit tests (11/11), Order pages unit tests (16/16) | immediate/deferred completion, retry, callback dispatch, and refund outcomes preserved |
| `AC-003` | unit + integration | payment-job result mapping, `flow-order-outbox`, callback controller/HTTP, and `refund-domain` suites | rejection/conflict, callback, and refund failures remain non-success outcomes |
| `AC-004` | type + architecture | `pnpm typecheck`; SW-102 release baseline (4/4); B17/public-contract architecture tests (15/15); semantic artifact `--check` | Commerce public contract retained |

## Review and remaining gate

- Independent Sol/high review: PASS. The deferred lifecycle gap was closed with a PostgreSQL integration case that persists instructions/deadline, confirms the same attempt, and proves one paid event.
- `git diff --check` passed for this slice.
- The final repository gate `make verify` remains pending until the remaining authorized stories are integrated.
- Downstream sequencing issue recorded in [ticket 103](../../../docs/tickets/103-payment-abi-consumer-migration.md): SW-118's SDK-only boundary cannot remove remaining adapter and Commerce refund consumers. Resolve that consumer migration before ABI contraction; it does not block SW-117's neutral initiation path.
