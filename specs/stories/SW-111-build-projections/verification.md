# SW-111 verification

## Result

Server, worker, Admin, and CLI bundles now resolve the projection selected by the release catalog. Build metadata records a stable target order, selected source, artifact status, and source graph fingerprint. Target graph checks reject unresolved or cross-target imports with release, target, and source context. Base Admin remains disabled; Commerce Admin is built or reused only when its release and graph provenance match.

The Admin Vite build emits a provenance sidecar containing the selected release/source, normalized module graph, and output-tree digest. `scripts/build.mjs` validates that sidecar when `--skip-admin` reuses an existing build, verifies the copied files, then removes the sidecar from the final public Admin directory. An explicitly configured but missing Admin cache fails the build. Existing Admin caches without provenance must be rebuilt with `pnpm build:admin` before reuse.

Native packaging data now comes from the release catalog. The staging test exercises `scripts/build-release.sh` for Base and Commerce and compares the staged config files, smoke script, and systemd units with their existing sources.

## Checks

- Independent Sol/high review — passed after resolving the `--skip-admin` compatibility and native staging findings; the final delta review found no remaining material issues.
- `pnpm typecheck` — passed.
- Focused projection and native staging tests — 9/9 passed.
- SW-102 baseline, Admin artifact, and CLI graph tests — 7/7 passed.
- Focused release artifact integration tests — 4 passed; the complete file passed again in `make verify`.
- `node --check scripts/build-projections.mjs`, `node --check scripts/build.mjs`, `bash -n scripts/build-release.sh`, and `git diff --check` — passed.
- Full `make verify` — passed: backend and Admin typechecks; unit/architecture 115 files / 1,306 tests; Admin 32 files / 351 tests; integration 107 files / 906 tests.

## Evidence and boundaries

- SW-102 baseline tests confirm deterministic Base and Commerce selections and projection fingerprints. The added metadata leaves existing target graph fingerprints unchanged.
- Integration builds verify Base, Commerce, and `file-requests` selection, target isolation, build metadata, artifact presence, and process lifecycle.
- Admin reuse coverage builds a real Commerce Vite artifact, reuses it through `--skip-admin`, rejects an explicit missing cache, verifies copied bytes, and confirms provenance is absent from final output.
- Native staging coverage compares both release plans' exact config filenames and file contents, smoke script, systemd units, and Admin presence.
- No database schema, migration, or product behavior changed. No commit, push, merge, or deploy was made.
