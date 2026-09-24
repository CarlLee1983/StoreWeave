# Acceptance Criteria

## Happy Path

* [x] AC-001: Explicit backend-authorized operator Property, Availability, Reservation, refund, and evidence routes invoke only their declared capabilities; a provider-verified callback is resolved by unique reference and handed exactly once through the Reservation payment-result capability.

## Business Rules

* [x] AC-002: Operator routes enforce backend permission and no generic REST-to-Command route exists; repeated valid callback acknowledgement is idempotent and HTTP itself performs no Reservation transition.
* [x] AC-003: Late/Excess success remains a traceable domain/refund outcome and never revives/reoccupies a Reservation.

## Failure Cases

* [x] AC-004: Invalid signature, malformed payload, unknown reference, unsupported method, replay, unauthorized operator, and invalid operator refund/evidence input receive safe handling.

## Regression Requirements

* [x] AC-005: Callback diagnostics retain correlation evidence but omit raw management tokens and unnecessary PII; untrusted correlation headers are accepted only as UUIDs.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | operator and callback adapter suite | authorized operator fixtures and verified provider callback | explicit operator capabilities invoked; unique callback reference reaches capability |
| `AC-002` | integration/architecture test | operator permission, route inventory, and duplicate callback cases | forbidden operator, built adapter, same signed callback twice | forbidden/generic routes absent; safe duplicate acknowledgement |
| `AC-003` | integration test | late/excess callback fixtures | expired/cancelled or winning Reservation | refund work/evidence; no revival/reservation increase |
| `AC-004` | integration test | invalid callback/operator matrix | signature/reference/payload and operator refund/evidence variants | safe rejected/acknowledged provider or operator outcome |
| `AC-005` | log assertion | callback audit capture | all callback outcomes | correlation only; no secrets/PII leakage |
