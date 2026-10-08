# Story: SW-185 Direct home-delivery order contract

## Goal

Retain `commerce.order.placeOrder` / `POST /api/v1/orders` as a cartless Customer purchase, with confirmed prices, a merchant home-delivery method, normalized address and confirmed shipping fee. Issue #125 authorizes this follow-up to ADR 0054.

## Scope

Order owns the strict DTO and handler. Reuse `createOrderFromLines`; do not synthesize carts or add another write path. Update existing REST/direct Command, seed and smoke callers. MCP currently has no direct-order tool. Pickup remains cart checkout only because verified selection is cart-bound.

## Rules

Exactly one confirmed price per distinct input product is required; no missing, extra or duplicate confirmation. Preserve input line order because pricing uses it to break allocation ties. Confirmed-price order and address edge whitespace are normalized. Both price and fee mismatches reject atomically with current values. New requests use actor-scoped keys and full parsed input for replay matching, including prices, address, currency and metadata; confirmed shipping fee is first-use-only and omitted from replay matching. A successful same-key replay does not reprice or reserve again; changed content mismatches.

## Transition

Depends on SW-186 and SW-187. Own historical global keys are checked before any new scoped claim: changed old purchase facts mismatch; otherwise return a structured `legacy_order_exists` validation refusal with the original order ID/number and explicit statement that new delivery was not applied. Do not return a no-delivery historical order as a newly fulfilled purchase. Another Customer's old key is ignored. Old request shapes fail strict validation. Drain old API and command writers before cutover; mixed old/new writers are unsupported. Preserve all old and new rows. Rollback requires a write freeze or compatible release because old writers cannot see new scoped keys.

## Acceptance boundary

Real PostgreSQL, REST and direct Command tests prove confirmations, immutable delivery, actor isolation, concurrent retries, legacy duplicate prevention and unchanged cart behavior. No new dependency or data migration. Complete gate and smoke flows must pass.
