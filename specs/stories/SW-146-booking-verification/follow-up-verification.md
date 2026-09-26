# Remaining issue verification — 2026-09-26

This is the completed repository-check record for the user's request to complete the remaining GitHub issues with Sol. It supplements the earlier revision-specific verification record; it does not replace that historical result or clear external gates.

## Candidate

Base revision: `013822c` (working-tree changes, not committed). Node `22.17.1`, pnpm `12.0.0`, Docker `29.4.0`. No commit, push, issue closure, deployment or external UAT has been performed in this work batch.

| Issue | Change / evidence | Current verification |
| --- | --- | --- |
| #100 | Booking package `./admin` export and TS path alias both resolve `src/admin.tsx`; regression checks exported files and alias consistency. | Booking release unit 6/6, Booking Admin typecheck, root typecheck; Sol independent review clean. Full gate passed at checkpoint 4. |
| #99 | Clean-start graph matcher recognizes the actual `apps/api/src/releases/commerce.ts`, normalizes separators, and exercises positive/negative paths. | Booking clean-start integration 7/7; Sol independent review clean. Full gate passed at checkpoint 4. |
| #98 | Base, Commerce and Base-derived file-requests builds reject Booking domain/release/theme/HTTP adapter/seed inputs. Tests call the real build graph validator for each forbidden category and allowed paths. | Focused architecture 12/12, root typecheck; Sol independent review clean. Full gate passed at checkpoint 4. |
| #110 | [SW-157](../SW-157-multi-room-reservation-evidence/story.md) adds four real PostgreSQL Reservation cases: valid multi-room occupancy, invalid occupancy before Room Night locks, later-night shortage, and two blocked contenders for the final two units. | Focused integration 4/4; root typecheck; Sol/high independent review clean. Full gate passed at checkpoint 4. |
| #80 / local ticket 116 | Booking media preview is authorized by an active Room Type reference before Base Media is opened. The selected Booking Release test renders the image URL and reads actual processed WebP bytes; missing/unreferenced/disabled/detached references cannot open storage. | Selected Release journey integration 3/3 after dedicated Property reference query and lookup index; Sol/high final delta review clean. Full gate passed at checkpoint 4. |
| #97 | [SW-158](../SW-158-native-release-layout/story.md): native layout metadata and generic safe snapshot identities, with explicit historical readers. | New unit 36/36, existing focused validation/snapshot checks, real isolation/staging 9/9, upgrade integrations 4/4, typecheck and Sol/high review clean. Integrated full gate passed at checkpoint 4. |
| #46 | Selected Booking module/HTTP contract checks and explicit Release-by-surface inventory; [SW-159](../SW-159-refund-reconciliation-schedule/story.md) fixes an hourly refund payload rejected by the Worker decoder. | Refund payload unit 7/7, real scheduled Worker integration 1/1, typecheck and Sol/high review clean. Final contract audit complete; full gate passed at checkpoint 4. ECPay refund UAT, real SMTP, deployment and operator acceptance remain separate unresolved gates. |

## Full gate checkpoint history

The first run, `make verify > /tmp/storeweave-remaining-issues-verify.log 2>&1`, was deliberately interrupted during unit tests to add the media lookup index found missing during independent review. Make exited 2 after the test process received SIGINT (130). Both typechecks had passed; this interrupted run is not a passing gate.

The fresh run is `make verify > /tmp/storeweave-remaining-issues-verify-2.log 2>&1`. Its source snapshot digest is `570ac96b8cc38d7430c781039fef87bddfc75384add3b3d3f9fae092647311ea`: SHA-256 over sorted unique `git ls-files -co --exclude-standard -z` file paths, excluding `docs/`, `specs/`, and `*.md`, each encoded as path bytes + NUL + SHA-256 file digest bytes. Base revision remains `013822c`. This run exited 2 during unit tests: 154 files and 1526 tests passed, but the B17 semantic provenance artifact was stale after adding the Booking controller. Admin and integration suites did not run. A separately generated candidate changed only the source-file provenance (new controller and changed Booking adapter), with semantic facets/hashes unchanged. The reviewed artifact and documented hash were updated, and its explicit `--check` passed. A fresh full checkpoint is required after integration of SW-158 and SW-159.

## Retained focused failure

The first media journey run (`/tmp/storeweave-booking-media-test.log`) failed because the new fixture sent unsupported Room Type status `inactive` instead of the repository's `disabled`. The resulting active unpriced fixture also broke the following search case. The fixture now uses `disabled` and deactivates its own Room Type in `finally`. Run 2 passed 3/3 (`/tmp/storeweave-booking-media-test-2.log`); run 3 after the Property query change passed 3/3 (`/tmp/storeweave-booking-media-test-3.log`); run 4 with the additive partial index and PostgreSQL index assertion passed 3/3 (`/tmp/storeweave-booking-media-test-4.log`). These local logs are temporary artifacts, not durable CI evidence.

## #97 boundary established by analysis

`validateReleaseDirectory` validates native installation media, including its runtime executable, wrapper, config examples and systemd units. `scripts/build.mjs` application output is a different artifact. Booking currently has no native packaging plan (`booking.native` is undefined), so accepting the ID alone cannot make its application output valid native installation media.

The recommended change is selected, serializable native layout metadata, checked against release/build/manifest identity and required files, with a strict historical reader for existing Base/Commerce native archives. Do not execute an untrusted artifact's CLI projection to obtain its layout. Preserve old paired snapshot shapes/checksums and B01 Commerce bridge restrictions. The related generic snapshot/storage schemas must accept safe release identities without weakening cross-artifact equality checks. Shared code must not acquire another product-ID map disguised as a helper. Native Booking packaging and application-artifact validation must be distinguished explicitly; installation checks cannot be relaxed to accept an incomplete archive.

Relevant regression surfaces: `tests/unit/release-validation.test.ts`, `tests/unit/release-snapshot.test.ts`, `tests/architecture/native-release-staging.test.ts`, CLI paired/legacy upgrade integration and release-isolation R3 exceptions. SW-158 now implements this boundary; its focused checks above do not replace the integrated full gate.

## Integrated checkpoint 3

After integrating SW-158, SW-159 and the selected Booking Extension/HTTP contract checks, the stable candidate runs `make verify > /tmp/storeweave-remaining-issues-verify-3.log 2>&1`. Base revision is `013822c`; source digest using the method above is `025cf91d420fbdb146669d71a37b3b859cce19fa137b1fdcd5e3ad37fad48fee`. The wrapper preserves the final exit code in `/tmp/storeweave-remaining-issues-verify-3.exit`. Source edits are frozen during this checkpoint; documentation updates do not alter the digest. Result: exit 2 during unit tests. Both typechecks passed; 157 unit files / 1,576 tests passed, while `release-baseline.test.ts` failed because Base CLI import graph differs from its checked-in baseline. Admin and integration did not run. The failure is retained; a temporary projection was then compared before updating the baseline, as recorded below.

Selected Booking contract checks passed 7/7 and public HTTP integration passed 19/19 before this run. The explicit [contract inventory](contract-surfaces.md) records both raw helper applicability diagnostics, strict notification variants, internal HTTP exclusion, direct system-actor guards, and selected mock-payment Extension SDK checks. The architect's final audit found no further demonstrated repository product defect; final full-gate evidence and documentation reconciliation remain necessary. The old §9.11 production-log and §9.14 shared-shell-typecheck caveats bound the evidence and do not add requirements absent from Spec 0011.

## Updated Spec 0011 §9 mapping for this candidate

The test paths in the historical [17-row matrix](verification.md) remain applicable except for the explicit additions below. Checkpoint 4 executed the entire suite; earlier passes certify only their recorded revisions.

| §9 | Current executable evidence / external boundary |
| --- | --- |
| 1 | [Contract surface inventory](contract-surfaces.md), selected Booking module/Extension architecture checks and public HTTP integration. The two generic helper diagnostics have exact, separately checked applicability boundaries. |
| 2 | Booking clean-start integration plus existing three-Release graph checks; #99 corrects the Commerce adapter matcher. |
| 3 | Existing release baseline, migration history, artifact/transition and Commerce regression tests, plus SW-158 native validation/upgrade compatibility checks. |
| 4 | Existing payment provider contracts and Booking payment/refund integration; real merchant refund UAT stays external. |
| 5 | Existing real PostgreSQL last-unit races and SW-157 multi-room contention. |
| 6 | Existing stale Quote/unavailable-supply tests and SW-157 no-partial-write cases. |
| 7 | Existing cancellation/expiry/refund cases plus SW-159 scheduled Worker refund reconciliation. |
| 8 | Existing direct callback/cancellation and callback/expiry lock-order cases introduced by PR #111, now included in the current full gate. |
| 9 | Existing fresh/concurrent Payment Attempt, callback replay and Excess refund cases. |
| 10 | Existing Late Payment/refund/operator-alert cases; actual SMTP delivery stays external. |
| 11 | Existing hash-only/single-use credentials, replay/revocation, captured diagnostic redaction and clean-URL tests. Production log infrastructure is outside local evidence. |
| 12 | Existing proof-plus-Account identity, concurrent claim and revoked-access cases. |
| 13 | SW-157's four real PostgreSQL Reservation cases combine occupancy, multi-night inventory and multi-room contention. |
| 14 | Existing named missing-renderer/Admin failures and Booking projection/browser graph checks; ticket116 adds selected rendered media URL plus real processed preview bytes. |
| 15 | Existing positive/negative release-isolation graph scans, strengthened Booking forbidden inputs (#98), export checks (#100), and native validator branching removal (#97). |
| 16 | Existing retention/redaction/evidence-preservation cases; public HTTP integration additionally checks the internal retention command's system-actor guard. |
| 17 | Integrated checkpoint 4: exit 0, both typechecks and all three suites passed with matching source digest. |

Independent Sol/high review of the final contract-test checkpoint was clean. The HTTP catalog assertions cover every internal command derived from the composed Reservation module; direct actor guard regressions cover notification materialization and retention, with the remaining guards inspected during review. ECPay merchant UAT, real SMTP, production configuration/deployment and operator acceptance remain unresolved and cannot be inferred from this mapping.

### Checkpoint 3 failure resolution

A temporary SW-102 projection was compared before updating its pinned fixture. Sol built current and clean-HEAD CLI graphs into temporary directories: Base 186→187 and Commerce 375→376 inputs, each adding only `tools/cli/src/native-layout.ts` and removing nothing. Removing that path reproduces the old arrays and checksums exactly. The fixture has nine scalar changes: both CLI target/projection counts and checksums, plus the already-reviewed B17 provenance artifact hash. All manifests, selections, server/worker/admin graphs and other contract hashes are unchanged. Independent Sol/high review was clean. The primary copied the candidate to `tests/architecture/fixtures/sw-102-release-baseline.v1.json`; test logic and product code were unchanged. The focused baseline rerun and new full gate subsequently passed at checkpoint 4.

## Integrated checkpoint 4

Focused release baseline rerun: 4/4 passed (`/tmp/storeweave-release-baseline-focused.log`). Fresh command: `make verify > /tmp/storeweave-remaining-issues-verify-4.log 2>&1`; exit status is preserved in `/tmp/storeweave-remaining-issues-verify-4.exit`. Base `013822c`, source digest `2d3e7003bdf936ed22916d768e342465036cd3ca1f609f329371f6981615db23` by the same method. Source stayed unchanged; result **exit 0**. Completed 2026-09-26 before 01:59:20 UTC. Both typechecks passed; unit 158 files / 1,577 tests, Admin 32 files / 351 tests, integration 115 files / 1,032 tests. The source digest was recomputed after completion and matched. Log SHA-256: `f1c9e2d37f1105feb0f2a9d1d2326845cb35f0bfc31a87fd037c6f2f97a3730d`. The local log and exit file are temporary artifacts, not remote CI evidence.

## Repository completion and external handoff

All locally implemented remaining issue slices (#97, #98, #99, #100, #110, #80/media and #46 repository evidence) have focused checks, independent review, and the passing integrated checkpoint above. Final diff whitespace review passed. SW-146 AC-001 now maps all 17 conditions to bounded checks or explicit external gates; AC-002 is supported by this candidate’s full run. At checkpoint 4 the application changes were uncommitted, and no remote issue closure, commit, push, deployment, provider operation or message to another person had been performed.

#46 repository/Story work is complete on this candidate. Booking production release readiness remains gated by merchant ECPay refund UAT, intended SMTP delivery/retry, production configuration/deployment, and named operator acceptance. These external executions are explicitly outside issue #46 and SW-146 execution scope; Spec 0011 §9.4 and §9.17 require keeping their release gates separate, not performing them to finish the repository work. The existing [external gate matrix](verification.md#separate-external-release-gates) specifies the required retained artifacts for a separately authorized release. No local fixture substitutes for those results.

### Final scope audit — 2026-09-26

A fresh read of all seven open GitHub issue bodies confirmed the implemented requirements. #97 removes modern product-ID validation branches while retaining explicit historical formats; #98 guards Base/Commerce builds; #99 fixes and tests the real adapter matcher; #100 fixes the admin type export; #110 has direct PostgreSQL multi-room evidence; #80/SW-135 has all ten local acceptance criteria checked with the media route and current HTTP/full-gate evidence; #46 has the reviewed 17-condition mapping. The current source digest still matches checkpoint 4 and its preserved exit code is 0.

Sol/high independently confirmed that external UAT/SMTP/deployment execution is outside #46/SW-146 scope. The earlier request for external environment inputs was unnecessary for this implementation objective and is withdrawn. Remote trackers remain open because issue editing/closure was not authorized. Local completion does not claim publication, deployment, or production release readiness.

## PR preparation — 2026-09-26

The user subsequently authorized publishing a PR to close the completed issues on merge. The implementation was committed on `fix/booking-remaining-issues` and rebased without conflict onto `a95ad2c` (PR #115). The upstream delta only changes the Booking Reservation test notification-drain helper and adds its historical ticket. Checkpoint 4 remains evidence for its exact pre-rebase source digest; it is not relabeled as a full run on the rebased candidate. PR CI must validate the updated candidate. The PR will link #46, #80, #97, #98, #99, #100 and #110 for automatic closure after merge. No merge, deployment or external release gate execution is authorized by this step.
