# SW-158 — Release-owned native artifact layout

## Goal and authority

Resolve GitHub #97 under the user’s request to finish the remaining issues. Native validation must read the selected artifact’s declared layout without adding another product branch. Local code, documentation and checks are authorized; commit, publication and deployment are not.

## Boundary

Native artifacts now carry strict `native-layout.json` and `build-info.json.nativeLayoutVersion: 1`. The descriptor declares the safe release ID, executable/service/config name, and admin/theme asset presence. Validation retains identity equality, required files, executable bits and existing tree protections. The marker prevents deletion of the descriptor from silently selecting the historical reader. It is structural validation, not an authenticity signature.

Snapshot and storage schemas accept safe release identities while preserving source/candidate/evidence equality and existing checksum shapes. A fixed compatibility reader preserves only the existing Base/Commerce native formats; the B01 bridge remains explicitly Commerce 0.1.0. New releases require metadata. Booking currently has no native packaging plan: its application build remains insufficient for native installation. Generic validation does not claim generic installer deployment support.

## Acceptance

- [x] Modern native layout validation accepts Booking and an additional release identity with complete required native files, without product branches.
- [x] Malformed, mismatched, missing, downgraded or contradictory metadata and incomplete application artifacts fail closed.
- [x] Existing Base/Commerce native archives and B01 upgrade/snapshot compatibility remain covered.
- [x] Modern native packaging writes the descriptor and marker; snapshot readers preserve identity and name equality.
- [x] Focused checks and independent Sol/high review pass.
- [x] The integrated working tree passes `make verify`; SW-146 records candidate identity and evidence.

## Verification

The isolated candidate was reviewed at `/tmp/storeweave-issue97-20260926`; the same twelve owned files were copied to the main working tree. New native-layout unit tests: 36 passed. Existing focused validation/snapshot/staging/isolation checks: 90 passed before the marker delta, 75 passed after it. Real release-isolation plus staging: 9 passed. Paired upgrade, legacy upgrade and legacy safety snapshot integration: 3 files, 4 passed. Root typecheck passed. Final independent Sol/high marker review was clean. Local logs are `/tmp/storeweave-issue97-focused{-2,}.log`, `/tmp/storeweave-issue97-isolation.log`, and `/tmp/storeweave-issue97-integration.log`; they are temporary evidence, not CI artifacts.

The integrated unit gate additionally detected the expected CLI import graph change in the SW-102 pinned baseline. A reviewed candidate updates only Base/Commerce CLI counts/checksums for `native-layout.ts` and the already-reviewed B17 provenance hash; no other target, manifest or selection changes. See SW-146 checkpoint 3 failure evidence.

## Operations and rollback

No database migration or production operation is performed. New native packages emit the metadata; old native formats retain a narrowly scoped reader. Preserve complete archives and snapshot descriptors for rollback. Reverting this code restores the previous Base/Commerce-only validator and loses support for newly declared identities. Do not strip metadata to simulate historical compatibility.

Integrated `make verify` passed at SW-146 checkpoint 4; source digest, suite counts and retained failure evidence are recorded there.
