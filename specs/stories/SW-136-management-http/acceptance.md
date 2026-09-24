# Acceptance Criteria

## Happy Path

* [x] AC-001: A valid single-use Access Grant sets a scoped `HttpOnly`/`Secure`/`SameSite=Strict` management cookie and 303 clean URL; the resulting authorized management session or owning Account can safely read/update allowed Booker/Guest fields, cancel under policy, resend grant, and explicitly claim an Account.

## Business Rules

* [x] AC-002: Claim is explicit and authenticated; Email matching and client account id never create ownership.
* [x] AC-003: Self-service cancellation is whole-Reservation only, enforces the frozen Cancellation Policy, and every state-changing management endpoint enforces CSRF protection plus an explicit rate limit.

## Failure Cases

* [x] AC-004: Missing/revoked/replayed Grant or session, CSRF failure, rate-limit exhaustion, non-owner Account, expired policy, immutable booking fact, and claim conflict return safe distinct errors without consuming valid authorization.

## Regression Requirements

* [x] AC-005: Management routes expose no raw token/unauthorized PII and retain no Admin/operator capability.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-001` | integration test | grant redemption and management HTTP suite | fresh signed grant, valid management session, and owning Account | 303/clean URL and scoped HttpOnly/Secure/SameSite=Strict cookie, then permitted operations |
| `AC-002` | integration test | claim authorization matrix | email match, client id, authenticated claim | first two forbidden; explicit claim succeeds |
| `AC-003` | integration test | cancellation/CSRF/rate-limit cases | valid and absent CSRF tokens; quota fixtures | whole cancel policy plus CSRF/rate-limit enforcement |
| `AC-004` | integration test | negative Grant/access/update matrix | replayed/revoked/CSRF/rate-limit/non-owner/conflict fixtures | safe status, no authorization consumption or data disclosure |
| `AC-005` | response/log assertion | management response snapshots | all management endpoints | no credentials or unneeded PII; no operator route |
