# SW-185–SW-187 verification checkpoint

## Successful complete gate

The unchanged staged source candidate passed `make verify` after the authorized Docker storage cleanup. Final exit **0** on 2026-10-08 Asia/Taipei, approximately 12:00.

| Gate | Result |
| --- | --- |
| Backend typecheck | Passed |
| Admin typecheck | Passed |
| Unit | 161 files / 1,603 tests passed |
| Admin | 32 files / 351 tests passed |
| Integration | 124 files / 1,078 tests passed |

Command: `DOCKER_HOST=unix:///Users/carl/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock make verify`.
Log: `/tmp/storeweave-125-verify-after-cleanup.log`. Subsequent edits change only verification/acceptance documentation; no code or tests were changed during either complete-gate run.

## Candidate

- Isolated worktree: `/tmp/storeweave-order-125`, branch `feat/direct-order-contract-125`.
- Base: merged main `ca149018d93c0e95adf183feef9cab3b62d17d8d`.
- Tested candidate Git tree: `d08a25b61446d2be68c2e9fe4f063b1915634e99`. This identifies the staged file content tested before a commit existed. The subsequent commit contains the same code/tests plus reviewed acceptance/evidence documentation. The user authorized commit, push and PR publication via `$pr` after all gates passed.
- Date: 2026-10-08 Asia/Taipei; frozen dependency install; Node 24.21.0, pnpm 12.0.0, OrbStack Docker 29.4.0, PostgreSQL `17-alpine`.
- Architect and independent reviewer accepted this checkpoint. The runtime callback fall-through finding was fixed with a fail-closed throw and regression test.

## Passing focused checks

- Backend typecheck and shell syntax: passed.
- Existing direct caller fixtures: 6 files / 54 integration tests passed.
- Direct-order plus cart replay/retry: 3 files / 17 integration tests passed.
- HTTP catalog plus direct-order: 2 files / 18 integration tests passed.
- Structural/semantic/release contract checks: 3 files / 26 unit tests passed.
- Final staged candidate Commerce Docker smoke: exit 0, 75 checks passed, 0 failed; complete backup/restore passed.
- Final staged candidate Commerce native smoke: exit 0, 74 checks passed, 0 failed; complete backup/restore passed.
- Both smoke evidence files identify the candidate tree above and bind the executed artifacts to their manifests: `/tmp/storeweave-125-docker-smoke/evidence.json` and `/tmp/storeweave-125-native-evidence.json`.

The generated HTTP catalog differs only at POST `/api/v1/orders`; the other 201 routes remain identical. Structural/semantic candidates and release baseline were generated and reviewed; exact release assertions remain in place.

## Complete-gate attempt — not accepted

Command: `DOCKER_HOST=unix:///Users/carl/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock make verify`.

- Both typechecks passed.
- Unit: 161 files / 1,603 tests passed.
- Admin: 32 files / 351 tests passed.
- Integration: 32 files passed / 92 failed; 474 tests passed / 130 failed / 474 skipped (1,078 total).
- Final make exit: 2. That failed run is superseded by the passing complete gate above.

Failures included native filesystem EIO, stopped PostgreSQL containers and MinIO `XMinioStorageFull`, followed by database connection refusals. A separate two-second Docker filesystem probe reproduced an environment failure: 98–99% capacity used, approximately 1.2 GiB free. Docker reports roughly 21.6 GB reclaimable images and 1.3 GB reclaimable build cache. No test or implementation was changed to mask these failures. Raw local log: `/tmp/storeweave-125-verify.log`.

The user explicitly authorized `docker image prune -af` and `docker builder prune -af`. They reclaimed 25.61 GB of images and 1.62 GB of build cache. Before/after inventory confirmed all existing 25 containers and 373 volumes were retained. The filesystem probe then passed at 70% use and approximately 25.7 GiB free; the unchanged source candidate passed the complete gate. No volumes or containers were pruned.

## Independent seed blocker

Isolated mock-only base demo seed passed; operations seed created two direct orders and their home-delivery snapshots, with zero shipping fees and 3/3 order-line prices matching catalog. It then failed on its first payment because the unchanged bootstrap does not activate/mount payment providers. This preexisting main behavior is tracked independently in [issue #127](https://github.com/CarlLee1983/StoreWeave/issues/127); no payment bootstrap fix is bundled here. No full operations-seed success is claimed. The disposable database/config were removed.

## Behavior proof

`tests/integration/direct-order-contract.test.ts` covers home-delivery HTTP success, immutable snapshots, first-use-only fee confirmation, changed purchase facts, strict confirmation mapping and pickup refusal, Customer key isolation, concurrent identical retries, legacy identity/privacy/no-write refusal, incomplete historical status, bad policy registration and a returning JavaScript callback failing closed. Legacy fixtures reconstruct historical rows rather than running a mixed-version writer; mixed old/new writers are explicitly unsupported by the rollout contract.

REST and direct Command callers, seed payloads and shared smoke inputs were migrated. There is no existing direct-order MCP tool to migrate. ADR 0055 and the architecture/spec references record the breaking input and coordinated rollout/rollback requirements. The user authorized publication after the passing checkpoint. Issue #125 remains open until the resulting PR lands; this change does not authorize merge or deployment.
