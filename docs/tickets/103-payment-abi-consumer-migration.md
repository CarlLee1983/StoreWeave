# 103 — Payment ABI consumer migration before contract cleanup

**What to build:** Migrate every remaining in-repository payment provider consumer and adapter from the legacy Order-shaped ABI to the neutral initiation/refund ABI, so SW-118 can remove legacy SDK symbols without editing those packages. This is a code-contract migration only; ECPay refund capability remains `unsupported` until SW-116 receives the merchant-approved product contract.

**Status:** complete — SW-118's consumer-migration prerequisite is satisfied.

## Acceptance

- [x] The extension SDK registry and extension registration path accept a V2-only payment provider while retaining the current ABI until SW-118 contracts it.
- [x] Mock Payment and ECPay adapters no longer expose or depend on legacy `start` / legacy refund inputs; their neutral V2 behavior, replay safety, and callback parsing remain unchanged.
- [x] Commerce refund invokes the neutral refund input using `amount`, while preserving refund-attempt references, provider success/rejection handling, and ECPay's `unsupported` result.
- [x] Commerce payment-method pages, callback handling, fixtures, and tests depend only on the shared neutral payment-provider surface they actually use.
- [x] Source/import inventory finds no in-repository consumer of `PaymentStartInput`, `PaymentStartResult`, `PaymentProviderDuringMigration`, or the legacy refund amount field before SW-118 removes them.
- [x] Focused mock, ECPay, callback, Commerce Order, Commerce refund, and architecture/public-contract checks pass; no Commerce public command, query, event, persisted job payload, URL, or Order state behavior changes.

## Boundaries

- Depends on SW-114, SW-115, and SW-117. Must be complete before SW-118's SDK-only contract removal.
- Keep SW-116 blocked until merchant product/API details and staging UAT evidence are supplied. Do not infer an ECPay refund product or send network requests as a substitute.
- Do not implement Booking payment consumers or alter Commerce public contracts.
- Requires Sol/high design analysis and independent Sol/high review because it crosses the provider registry, adapters, and payment/refund callers.

## Evidence

SW-117 review on 2026-09-21 found that `packages/commerce/refund/src/module.ts` still calls `refund({ amountCents })`, while the mock and ECPay adapters retain legacy `start`/refund wrappers and the SDK registry only admits the transition type. SW-118 is bounded to `packages/platform/extension-sdk` and forbids consumer-package changes, so its current AC-001/AC-004 cannot remove those remaining uses within its stated boundary. This ticket provides the missing consumer migration checkpoint; it does not change SW-116's merchant-capability blocker.

Implementation and verification completed on 2026-09-22. Provider contract validation now runs in ExtensionHost preflight before any shared registry mutation and remains enforced for direct ProviderRegistry callers. Regression coverage proves a malformed legacy payment provider cannot leave an earlier valid provider partially mounted. ECPay tests also parse a callback for an adopted historical TradeRecord, and Commerce refund integration covers a transport timeout remaining retryable without recording a terminal result.

Focused evidence: extension SDK + ECPay unit tests, 40/40; runtime lifecycle integration, 16/16; refund-domain integration, 6/6; SW-102 release baseline, 4/4; B17 semantic contract, 10/10; `pnpm typecheck`; B17 semantic `--check`; `git diff --check`. The source inventory under `packages`, `apps`, `tests`, and `tools` found old payment ABI names only in their SDK declarations and legacy type declaration, with no consumer imports or calls.

Full repository gate: `make verify` passed on 2026-09-22 — TypeScript and Admin type checks; unit 137 files / 1,419 tests; Admin 32 files / 351 tests; integration 111 files / 940 tests. The B17 semantic ledger and SW-102 public-contract input fingerprint were refreshed from reviewed generated candidates; the Commerce public-contract semantic checks pass. SW-116 remains blocked on merchant-approved ECPay refund contract and UAT evidence, and SW-118 remains a separate dependent contract-removal story.
