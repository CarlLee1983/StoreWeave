# B11 驗收對照

| 要求 | 證據 | 狀態 |
| --- | --- | --- |
| PostgreSQL shared cache、get/set/delete、TTL、exact namespace clear | `@storeweave/cache` 與 `cache-and-mutex.test.ts` 的 two-pool / child-process cases | passed |
| 過期 cleanup 可 bounded 並行 | `PostgresCacheManager.clearExpired()` 的 `SKIP LOCKED` SQL 與 integration cases | passed |
| provider outage 不偽裝成 miss，資料不是權威來源 | cache adapter throw semantics、outage regression、README 邊界 | passed |
| 跨程序 mutex、timeout、owner、connection lifecycle | `PostgresMutexManager`、跨 process、競爭／abort／backend termination integration cases | passed |
| B02 migration／release manifest／Base 與 Commerce 組裝相容 | `platform-cache/0001_init` module、release manifest／base-release assertions | passed |
| typecheck、build、focused unit/release integration、獨立 Sol/high review | `pnpm typecheck`、`pnpm build`、45 focused integration tests、review | passed |
| full `pnpm test` | 807 passed / 3 failed；B11 Docker workspace manifest failure 已修正並重跑通過，餘 `theme-assets-http` 既有 route 斷言與 `cli-upgrade` 5s timeout 非 B11 邊界 | blocked by pre-existing failures |
