# 104 — Booking Quote signer runtime seam

**What to build:** Make the existing configured signing Keyring available to the Booking Availability Quote capability at runtime without passing secret values into build-time Release projections. SW-122 now requires a purpose-derived `booking-quote` HMAC key to meet Spec 0011's tamper-resistant Quote fingerprint contract, while Release `createModules` currently receives only config and providers before the Kernel resolves secrets.

**Status:** open — blocks wiring the production Booking Quote in SW-138.

## Acceptance

- [ ] Runtime Booking Availability receives the Keyring resolved from the configured `security.signingKeys` secret references; no duplicate secret source or ambient environment lookup is introduced.
- [ ] Build manifest and target projection generation remain secret-free and can construct module metadata without signing material.
- [ ] A missing or invalid required signing key fails startup before the Booking Quote endpoint is available.
- [ ] A production Release integration test proves the Quote HMAC uses the Keyring resolved by bootstrap from the configured secret reference.
- [ ] Signing material and derived keys never appear in manifests, logs, errors, or public Quote output.
- [ ] Platform/runtime tests and `make verify` pass.

## Boundaries

- Depends on SW-122; complete before SW-138 wires the Booking Quote module.
- Keep the signer purpose-scoped to `booking-quote`; do not expose raw secrets to Release contributions or build projections.
- Requires Sol/high design and independent Sol/high review because this changes secret flow across Release and Runtime boundaries.

## Evidence

SW-122 package integration can resolve the existing Keyring via `resolveKeyring(config, secrets)` and inject it into the Availability module directly. The production Release path cannot: `RuntimeReleaseDefinition.createModules` accepts only `{ config, providers }`, and `bootstrapRelease` constructs modules before `createRuntime` resolves the Keyring. SW-138 currently excludes Platform Release contract changes, so the Quote's signing dependency needs this explicit runtime seam before production wiring.
