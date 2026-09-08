# B03 acceptance matrix

狀態：2026-09-08 `done`。本表以 [B03 card](../b00/next-work-cards.md#b03--模組-http-與安全-transport)
與 [Spec 0009 F02](../../specs/0009-complete-modular-base.md) 為需求來源。`Implemented` 只表示 source、focused
evidence 與已列 scoped review；只有「final gate」全數通過才可結案。

| Requirement | Source / focused evidence | Status |
| --- | --- | --- |
| selected Base／Commerce assembly；unselected route absent | [release server](../../../apps/api/src/release-server.ts)、[Base HTTP](../../../tests/integration/base-http.test.ts)、[HTTP/MCP](../../../tests/integration/http-and-mcp.test.ts) | Accepted |
| REST simple／composed、raw、direct、extension、MCP、callback | [transport contract](../../../apps/api/src/http/contract.ts) derives catalog from controller metadata and descriptor declarations; [HTTP/MCP tests](../../../tests/integration/http-and-mcp.test.ts) | Accepted |
| Storefront HTML redirect／PNG and release static protocols | [release server](../../../apps/api/src/release-server.ts)、[Base HTTP](../../../tests/integration/base-http.test.ts)、[HTTP/MCP tests](../../../tests/integration/http-and-mcp.test.ts) | Accepted |
| one declaration for input/output/auth/error/permission/idempotency | [contract](../../../apps/api/src/http/contract.ts) and existing descriptors; no hand-written parallel Zod/OpenAPI schema | Accepted; whole-B03 review pass |
| startup catalog exactly matches mounted routes | [startup validation](../../../apps/api/src/release-server.ts)、[contract validator](../../../apps/api/src/http/contract.ts)、[Base HTTP tests](../../../tests/integration/base-http.test.ts) | Accepted |
| no fake OPTIONS; HEAD only automatic annotation; CORS explicit `OPTIONS *` | [CORS contract](../../../apps/api/src/http/cors.ts)、[catalog tests](../../../tests/integration/base-http.test.ts) | Accepted; packaged probe pass |
| artifact determinism, activation identity, no DB extra work/secrets, strict JSON, atomic no-overwrite | [artifact writer](../../../apps/api/src/http/catalog-artifact.ts)、[artifact tests](../../../tests/integration/http-catalog-artifact.test.ts)、[usage](README.md#artifact-output-usage) | Accepted; no dangling local `$ref` |
| date, pagination and unknown-field validation | [HTTP contract](../../../apps/api/src/http/contract.ts)、[Base HTTP tests](../../../tests/integration/base-http.test.ts) | Accepted |
| anonymous/session/bearer/permissions and CSRF boundaries | [release server](../../../apps/api/src/release-server.ts)、[Base HTTP](../../../tests/integration/base-http.test.ts)、[HTTP/MCP](../../../tests/integration/http-and-mcp.test.ts) | Accepted |
| body limit, trusted proxy, 19 POST rate assignments and thresholds | [release server](../../../apps/api/src/release-server.ts)、[contract metadata](../../../apps/api/src/http/contract.ts)：auth 6 routes, IP 60/min plus IP+normalized-email 10/min (IP first); coupon 2／20/min, cart 10／120/min, callback 1／300/min; HTTP integration coverage | Accepted; rate-limit Sol review pass |
| CORS exact canonical allowlist and native preflight behavior | [CORS implementation](../../../apps/api/src/http/cors.ts)、[operations policy](../../operations.md#cors)、focused Base/Commerce/static/artifact tests | Accepted; packaged Base probe pass |
| generated, machine-checkable HTTP documentation | startup-validated `storeweaveHttpCatalog`; optional [startup artifact](../../../apps/api/src/http/catalog-artifact.ts) | Accepted |
| serial test configuration without changing timeout policy | [Vitest config](../../../vitest.config.ts): root `fileParallelism: false`, integration timeout 180s | Accepted |
| dependency / persistent-data / public URL boundary | `package.json`／lock unchanged; protected release 2461-file hash map final5 has 0 changes | Accepted |
| rollback / operational notes | artifact does not overwrite user output; CORS policy is documented in [operations](../../operations.md#cors) | Accepted; no rollback certification claimed |

## Current focused evidence

- `pnpm typecheck`: final5 exit 0.
- `pnpm test`: final4 58 files／732 tests, 78.67s, exit 0, `/tmp/storeweave-b03-final4-unit.log`.
- focused final4 integration: cart HTTP、HTTP/MCP、catalog artifact 3 files／98 tests, exit 0.
- `pnpm test:integration`: final5 79 files／657 tests, 721.94s, exit 0,
  `/tmp/storeweave-b03-final5-integration.log`; isolated B02 CLI 2／2, 108.17s.
- `pnpm typecheck:admin`: final3 exit 0, `/tmp/storeweave-b03-final3-admin-typecheck.log`.
- `pnpm test:admin`: final3 26 files／314 tests, 67.84s, exit 0, `/tmp/storeweave-b03-final3-admin.log`.
- CORS final focused rerun: `pnpm config:schema && pnpm typecheck`; unit `release-config`, `theme-assets-http`,
  `ecpay-callback-http` (3 files／12 tests); affected integration `base-http`, `http-and-mcp`, `http-catalog-artifact`
  (3 files／96 tests), all exit 0. The earlier 4-file／124-test count predates the final parser correction and is not a
  current final claim.
- Whole-B03 Sol review: `CLOSED—PASS` after the final4 source corrections.

Historical full-suite failures remain relevant: `/tmp/storeweave-b03-final-integration.log` timed out at 180s in
`cli-legacy-upgrade` paired (79 files／653 tests, one failure); `/tmp/storeweave-b03-final2-integration.log` timed out at
180s in `cli-upgrade-paired` (same totals). Isolated follow-ups passed legacy 2/2 in 95.4s and paired 1/1 in 82s. They are
historical failures, not the current result: final3 integration passed 79 files／655 tests.

## Final gates

| Gate | Required evidence | Current status |
| --- | --- | --- |
| full checks | final5 typecheck/unit and 79 files／657 tests integration pass | pass |
| Base/Commerce packaged-runtime smoke | final5 native and Docker Base／Commerce logs pass | pass; local isolated evidence only |
| CORS packaged-runtime probe | final5 fresh Base image own-fixture probe pass | pass; local isolated evidence only |
| preservation and closure evidence | protected release 2461-file hash map: 0 changed; `git diff --check` pass | pass |
| final review | independent whole-B03 Standards + Spec source review | pass |

Do not infer full coverage from the focused passes above. No merchant DB, release artifact, external service or repository
history was written by this documentation work.
