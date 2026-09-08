# B03 acceptance matrix

狀態：2026-09-08 `in_progress`。本表以 [B03 card](../b00/next-work-cards.md#b03--模組-http-與安全-transport)
與 [Spec 0009 F02](../../specs/0009-complete-modular-base.md) 為需求來源。`Implemented` 只表示 source、focused
evidence 與已列 scoped review；只有「final gate」全數通過才可結案。

| Requirement | Source / focused evidence | Status |
| --- | --- | --- |
| selected Base／Commerce assembly；unselected route absent | [release server](../../../apps/api/src/release-server.ts)、[Base HTTP](../../../tests/integration/base-http.test.ts)、[HTTP/MCP](../../../tests/integration/http-and-mcp.test.ts) | Implemented; final integration + isolated smokes pending |
| REST simple／composed、raw、direct、extension、MCP、callback | [transport contract](../../../apps/api/src/http/contract.ts) derives catalog from controller metadata and descriptor declarations; [HTTP/MCP tests](../../../tests/integration/http-and-mcp.test.ts) | Implemented; final gate pending |
| Storefront HTML redirect／PNG and release static protocols | [release server](../../../apps/api/src/release-server.ts)、[Base HTTP](../../../tests/integration/base-http.test.ts)、[HTTP/MCP tests](../../../tests/integration/http-and-mcp.test.ts) | Implemented; final gate pending |
| one declaration for input/output/auth/error/permission/idempotency | [contract](../../../apps/api/src/http/contract.ts) and existing descriptors; no hand-written parallel Zod/OpenAPI schema | Implemented; final review pending |
| startup catalog exactly matches mounted routes | [startup validation](../../../apps/api/src/release-server.ts)、[contract validator](../../../apps/api/src/http/contract.ts)、[Base HTTP tests](../../../tests/integration/base-http.test.ts) | Implemented; final integration pending |
| no fake OPTIONS; HEAD only automatic annotation; CORS explicit `OPTIONS *` | [CORS contract](../../../apps/api/src/http/cors.ts)、[catalog tests](../../../tests/integration/base-http.test.ts) | Implemented; final CORS probe pending |
| artifact determinism, activation identity, no DB extra work/secrets, strict JSON, atomic no-overwrite | [artifact writer](../../../apps/api/src/http/catalog-artifact.ts)、[artifact tests](../../../tests/integration/http-catalog-artifact.test.ts)、[usage](README.md#artifact-output-usage) | Implemented; Sol `CLOSED — PASS`; final gate pending |
| date, pagination and unknown-field validation | [HTTP contract](../../../apps/api/src/http/contract.ts)、[Base HTTP tests](../../../tests/integration/base-http.test.ts) | Implemented; final integration pending |
| anonymous/session/bearer/permissions and CSRF boundaries | [release server](../../../apps/api/src/release-server.ts)、[Base HTTP](../../../tests/integration/base-http.test.ts)、[HTTP/MCP](../../../tests/integration/http-and-mcp.test.ts) | Implemented; final integration pending |
| body limit, trusted proxy, 19 POST rate assignments and thresholds | [release server](../../../apps/api/src/release-server.ts)、[contract metadata](../../../apps/api/src/http/contract.ts)：auth 6 routes, IP 60/min plus IP+normalized-email 10/min (IP first); coupon 2／20/min, cart 10／120/min, callback 1／300/min; HTTP integration coverage | Implemented; rate-limit Sol `CLOSED — PASS`; final integration pending |
| CORS exact canonical allowlist and native preflight behavior | [CORS implementation](../../../apps/api/src/http/cors.ts)、[operations policy](../../operations.md#cors)、focused Base/Commerce/static/artifact tests | Implemented; CORS Sol `CLOSED — PASS`; retained-image own-fixture probe pending |
| generated, machine-checkable HTTP documentation | startup-validated `storeweaveHttpCatalog`; optional [startup artifact](../../../apps/api/src/http/catalog-artifact.ts) | Implemented as catalog artifact; final artifact/gate evidence pending |
| serial test configuration without changing timeout policy | [Vitest config](../../../vitest.config.ts): root `fileParallelism: false`, integration timeout 180s | Implemented; does not prove all timeout causes |
| dependency / persistent-data / public URL boundary | baseline comparison: `package.json` and lock unchanged; no B03 DB migration or URL replacement | Preserved through preflight; post-gate preservation check pending |
| rollback / operational notes | artifact does not overwrite user output; CORS policy is documented in [operations](../../operations.md#cors) | Implemented safety notes; no rollback certification claimed |

## Current focused evidence

- `pnpm typecheck`: final3 exit 0, `/tmp/storeweave-b03-final3-typecheck.log`.
- `pnpm test`: final3 58 files／732 tests, 53.42s, exit 0, `/tmp/storeweave-b03-final3-unit.log`.
- `pnpm test:integration`: final3 79 files／655 tests, 589.18s, gate exit 0,
  `/tmp/storeweave-b03-final3-integration.log`.
- `pnpm typecheck:admin`: final3 exit 0, `/tmp/storeweave-b03-final3-admin-typecheck.log`.
- `pnpm test:admin`: final3 26 files／314 tests, 67.84s, exit 0, `/tmp/storeweave-b03-final3-admin.log`.
- CORS final focused rerun: `pnpm config:schema && pnpm typecheck`; unit `release-config`, `theme-assets-http`,
  `ecpay-callback-http` (3 files／12 tests); affected integration `base-http`, `http-and-mcp`, `http-catalog-artifact`
  (3 files／96 tests), all exit 0. The earlier 4-file／124-test count predates the final parser correction and is not a
  current final claim.
- Scoped Sol closures: artifact (after numeric-like-key P2), startup/static, rate-limit, and CORS. They are slice reviews,
  not the final B03 review.

Historical full-suite failures remain relevant: `/tmp/storeweave-b03-final-integration.log` timed out at 180s in
`cli-legacy-upgrade` paired (79 files／653 tests, one failure); `/tmp/storeweave-b03-final2-integration.log` timed out at
180s in `cli-upgrade-paired` (same totals). Isolated follow-ups passed legacy 2/2 in 95.4s and paired 1/1 in 82s. They are
historical failures, not the current result: final3 integration passed 79 files／655 tests.

## 待完成的最終 gates

| Gate | Required evidence | Current status |
| --- | --- | --- |
| full checks | actual final3 `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm typecheck:admin`, and `pnpm test:admin` logs | pass |
| Base/Commerce packaged-runtime smoke | local isolated packaged-runtime verification: `STOREWEAVE_RELEASE=base|commerce pnpm smoke:native` and `STOREWEAVE_RELEASE=base|commerce pnpm smoke:docker` logs | pending; not a deployment claim |
| CORS packaged-runtime probe | local isolated enabled-CORS probe using retained images and its own fixture | pending; not a deployment claim |
| preservation and closure evidence | final file list, baseline/current hashes, diff, post-gate protected-release hash verification, and independent closure evidence | pending; initial 52-path manifest is pre-Vitest/CORS only |
| final review | independent whole-B03 Standards + Spec review against final manifest | pending |

Do not infer full coverage from the focused passes above. No merchant DB, release artifact, external service or repository
history was written by this documentation work.
