# B08 acceptance

- [x] Signed, single-use, expiring links for password reset, email verification, and email change; the row carries no material that can rebuild the link (ADR 0038, ADR 0042)
- [x] Token creation, its encrypted pending value, and the outgoing mail commit in one transaction; a failed send leaves no issued token
- [x] Real mail delivery through `@storeweave/mail`; the notification Extension Provider is no longer on the identity path
- [x] Self-service accounts in a base-only release: register, verify, change email, reset password, revoke other sessions, with no commerce Customer anywhere (ADR 0041)
- [x] Commerce customer registration keeps its existing semantics and still creates the Customer in the same transaction
- [x] Database-owned API tokens that expire and can be revoked individually and immediately; a revoked name can be reissued so rotation does not force a rename; `auth.tokens` removed and a config still carrying it now fails to parse (ADR 0043)
- [x] Operator MFA with TOTP and single-use recovery codes, replay-protected by the consumed time step; enrolment does not lock an unenrolled operator out (ADR 0044)
- [x] A second factor is only offered where login checks it: roles that declare no `account.mfa` are refused at the enrolment endpoint, and a confirmed enrolment is always verified
- [x] `doctor` counts the operator accounts that owe an enrolment, so the "created but not enrolled" window is visible rather than only present in a login response
- [x] Account disable revokes every session; demotion and a removed role take effect on the next request without waiting for expiry
- [x] Per-account lockout after ten consecutive failures, indistinguishable from a wrong password, cleared by a success, by a password reset, and by time — an expired lock starts the count over, so a single wrong password cannot re-lock an account indefinitely
- [x] Resource-aware policy on `users:write`: an operator cannot disable their own account
- [x] Expired tokens and sessions are cleaned by `platform.identity.cleanup` rather than by an operator remembering
- [x] Login, forgot-password and email-change conflicts answer identically for a known and an unknown address, and both paths pay the full scrypt cost. Self-service registration is the stated exception: it still answers 409 for an address that is taken, because a self-service form has to tell the person that. The message carries no address, and the rate limiter is what makes list-walking expensive

## Automated checks

`tests/integration/identity-tokens.test.ts` (10) · `identity-http.test.ts` (8) · `api-tokens.test.ts` (8) ·
`mfa.test.ts` (10) · `account-security.test.ts` (9) · `password-reset.test.ts` · `auth-http.test.ts` ·
`release-roles.test.ts` · `base-http.test.ts` · `base-release.test.ts` · `tests/unit/api-token-guard.test.ts` ·
`tests/unit/release-config.test.ts` · `packages/platform/identity/test/policy-resource.test.ts`.

## Deployment preflight

Two settings become mandatory with this package and must be prepared before rolling it out:

1. `security.signingKeys` with a real 32-byte secret. A deployment without one no longer starts (ADR 0042).
2. Every existing `auth.tokens` entry must be reissued with `token:create` and the config block removed;
   a config that still carries it fails validation on purpose (ADR 0043).

Real SMTP delivery of the reset and verification mail is still a release gate rather than test evidence:
the repository has no authorized outbound mail server, so `mail.transport: smtp` must be exercised once
against a staging server before a deployment relies on password reset.

## Rollback

The identity migrations are additive except `0005_drop_password_resets`, which deletes the old table.
Rolling application code back does not restore it, and unused reset links live at most an hour, so the
recovery is "ask people to request a new link", not a data migration. `platform_api_tokens`,
`platform_user_mfa` and `platform_mfa_recovery_codes` must survive a rollback: removing them retires every
machine credential and every enrolled second factor at once. Removing a signing key from configuration is
still an immediate revocation of everything it signed — deliberate, never incidental.
