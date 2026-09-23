# 104 — Booking Quote signer runtime seam

**What to build:** Make the existing configured signing Keyring available to the Booking Availability Quote capability at runtime without passing secret values into build-time Release projections. SW-122 now requires a purpose-derived `booking-quote` HMAC key to meet Spec 0011's tamper-resistant Quote fingerprint contract, while Release `createModules` currently receives only config and providers before the Kernel resolves secrets.

**Status:** implemented — focused checks and ForgePilot `EV-006` full snapshot gate pass; ForgePilot still requires fresh verification of the current candidate. SW-138 remains responsible for consuming the seam in the production Booking Release.

## Acceptance

- [x] Runtime Booking Availability receives a `booking-quote`-only Keyring facade resolved from the configured `security.signingKeys` secret references; no duplicate secret source or ambient environment lookup is introduced.
- [x] Build manifest and target projection generation remain secret-free and can construct module metadata without signing material.
- [x] A missing or invalid required signing key fails startup before the Booking Quote endpoint is available.
- [x] A production-style synthetic Release bootstrap test proves the Quote HMAC uses the Keyring resolved from the configured secret reference. SW-138 remains responsible for production Booking Release wiring.
- [x] Signing material and derived keys never appear in manifests, logs, errors, or public Quote output.
- [x] Platform/runtime tests and `make verify` pass at the recorded `EV-006` snapshot.

## Boundaries

- Depends on SW-122; complete before SW-138 wires the Booking Quote module.
- Keep the signer purpose-scoped to `booking-quote`; do not expose raw secrets to Release contributions or build projections.
- Requires Sol/high design and independent Sol/high review because this changes secret flow across Release and Runtime boundaries.

## Evidence

SW-122 package integration can resolve the existing Keyring via `resolveKeyring(config, secrets)` and inject it into the Availability module directly. The production Release path cannot: `RuntimeReleaseDefinition.createModules` accepts only `{ config, providers }`, and `bootstrapRelease` constructs modules before `createRuntime` resolves the Keyring. SW-138 currently excludes Platform Release contract changes, so the Quote's signing dependency needs this explicit runtime seam before production wiring.

## Implementation evidence

- `PlatformModule.bindRuntimeSecurity` is paired with declared signing purposes and receives only a purpose-scoped Keyring facade, synchronously before `Database` construction or handler registration; undeclared derivation is rejected.
- Release manifests include sorted declared signing purposes, so build/runtime composition rejects configuration-dependent derivation authority before database construction.
- `composeBookingAvailabilityRuntime` keeps Quote, Search, and Quote Reservation behind one one-shot runtime closure; it fails closed when unbound, missing, malformed, or bound twice.
- `tests/unit/release-manifest.test.ts` bootstraps a synthetic Release from a configured environment secret, verifies the actual Quote HMAC, and rejects missing/malformed keys before database construction. It is deliberately not evidence that the future Booking Release is wired.
