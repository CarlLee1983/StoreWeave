# B03 模組 HTTP 與安全 transport

狀態：2026-09-08 `done`。B03 的 transport、catalog artifact、CORS 與 Vitest serial test configuration
已完成 final5 full integration、Base／Commerce native 與 Docker packaged-runtime smoke、enabled-CORS packaged probe、
protected-release preservation check 與 independent source review。B04 尚未啟動。

範圍以 [B03 派工卡](../b00/next-work-cards.md#b03--模組-http-與安全-transport)及
[Spec 0009 F02](../../specs/0009-complete-modular-base.md) 為準；逐項現況見
[acceptance matrix](acceptance.md)。Tickets 81–90 與 B00–B02 已完成，B04–B17 尚未實作。

## 現況與 ownership

- B03 的共用 HTTP／安全接線由主代理持有；本文件不將早期 primary 的 auth-input edits 改寫成「從未發生」。
- 選取的 Base／Commerce release 只掛載其 controllers、callback、extension、MCP 與 static routes；未選取模組
  的 route 不存在。實作以 [release server](../../../apps/api/src/release-server.ts)、
  [transport contract](../../../apps/api/src/http/contract.ts) 和 release adapter 為資料來源。
- catalog 在啟動後依實際 Fastify route identity 驗證；GET 的自動 HEAD 只作 annotation，沒有虛構 primary
  route。啟用 CORS 時，唯一自動 entry 是原生 `OPTIONS *`；空 allowlist 不掛 OPTIONS。
- 所有 catalog declarations 將 descriptor input／output、auth、permission、error、idempotency 與 rate bucket
  對齊同一 transport declaration；不維護第二套手寫 Zod／OpenAPI schema。
- 未新增 dependency：`package.json` 與 `pnpm-lock.yaml` 均與 B03 baseline 相同；CORS 使用既有 Nest/Fastify
  adapter。

## 已完成的 implementation slices（不等於最終驗收）

- REST simple／composed、raw、direct、extension wildcard、MCP、provider callback、Storefront HTML redirect／PNG
  與 static protocol 均已納入 catalog。實際掛載與 catalog 的 startup 驗證拒絕 phantom、漏宣告、重複與 orphan
  HEAD；不以 catalog 偽造 OPTIONS 或未掛載 route。
- validation 和 error mapping 保留既有 REST envelope、JSON 日期、分頁、unknown-field 拒絕，以及 HTML／redirect、
  provider acknowledgement、MCP JSON-RPC 的各自契約。session／bearer／permission、CSRF、body limit、trusted
  proxy 和 POST-only rate buckets 均維持既有安全邊界。
- [catalog artifact](../../../apps/api/src/http/catalog-artifact.ts) 僅在 successful activation 與 mounted catalog
  一致後，由 `STOREWEAVE_HTTP_CATALOG_OUTPUT` 以 strict stable JSON、same-directory exclusive atomic
  no-overwrite 寫出；identity 來自 `runtime.activatedRelease`，不另做 activation／DB query／provider setup。
  使用方式不重複於此，見本 README 的歷史記錄與既有維運文件。
- [CORS implementation](../../../apps/api/src/http/cors.ts) 採 exact canonical HTTP(S) allowlist，拒絕 raw／encoded
  wildcard、C0／DEL、empty port 與其他無效 origin，保留 IPv6／default port 正規化。原生 preflight 的 204／400、
  credentials、auth、CSRF 與 static/artifact 行為都有 focused evidence；操作 policy 見
  [CORS 維運文件](../../operations.md#cors)。
- [Vitest config](../../../vitest.config.ts) 將 `fileParallelism: false` 放在 root，維持 integration 180s timeout；
  這降低已知 parallel resource contention，不宣稱已證明所有 timeout 根因。
- composed body projection 在共用 `busHttpInput` 先拒絕未知欄位，不能在 descriptor strict validation 前靜默丟棄。
  catalog schema 使用無 local `$ref` 的產物，並記錄 authenticated raw route 的 401 guard error。

## Artifact output usage

在正常 API startup 前設定 `STOREWEAVE_HTTP_CATALOG_OUTPUT` 為既有目錄中的、不存在的絕對路徑；successful
activation 與 startup catalog validation 後才會寫出。重啟請改用 fresh path，或 unset 此變數；服務不會移除或覆寫
使用者 artifact。

## Final evidence

| 類別 | 現有證據 | 現在的結論 |
| --- | --- | --- |
| final3 typecheck | `/tmp/storeweave-b03-final3-typecheck.log`：exit 0 | 通過 |
| final3 unit | `/tmp/storeweave-b03-final3-unit.log`：58 files／732 tests，53.42s，exit 0 | 通過 |
| scoped Sol reviews | artifact（含 integer-like key P2）、startup/static、rate-limit、CORS 均 `CLOSED — PASS`；CORS 是最後 parser correction 後重審 | 各 slice 通過，非完整 B03 review |
| CORS focused checks | `config:schema && typecheck`、3 unit files／12 tests、受影響 integration `base-http`／`http-and-mcp`／artifact 3 files／96 tests 均 exit 0 | 通過；早先 4 files／124 tests 早於最後 parser correction，非最新聲明 |
| final3 integration | `/tmp/storeweave-b03-final3-integration.log`：79 files／655 tests，589.18s，gate exit 0 | 通過 |
| final3 admin | `pnpm typecheck:admin` exit 0，`/tmp/storeweave-b03-final3-admin-typecheck.log`；`pnpm test:admin` 26 files／314 tests，67.84s，exit 0，`/tmp/storeweave-b03-final3-admin.log` | 通過 |
| final5 typecheck／unit／focused integration | `pnpm typecheck` exit 0；`pnpm test` 58 files／732 tests，78.67s；cart／HTTP-MCP／artifact 3 files／98 tests exit 0 | 通過 |
| final5 integration | `/tmp/storeweave-b03-final5-integration.log`：79 files／657 tests，721.94s，exit 0；B02 CLI isolated rerun 2／2，108.17s | 通過 |
| Base／Commerce smokes | `/tmp/storeweave-b03-final5-smoke-{native,docker}-{base,commerce}.log` 各 exit 0；Base 10 checks、Commerce 61 native／62 Docker checks | 通過；都是 fresh local builds，不是 deployment claim |
| CORS packaged-image probe | `/tmp/storeweave-b03-final5-cors-packaged-base.log`：fresh Base image with allowlist fixture; allowed GET／preflight、denied preflight（無 ACAO）、invalid preflight 400 | 通過 |
| whole-B03 Sol review | final independent reviewer `CLOSED—PASS`；P1 composed-body strictness、raw guard error、nested-schema `$ref` 已修正 | 通過 |

基線是 `/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-base-b03-baseline-sh09hveu`
（804 original files，另有 metadata），指標為 `/tmp/storeweave-base-b03-baseline-path`；HEAD
`1f4470d810a84fc43d97c1990c32c5e71608dd7f`；目前 HEAD 是
`bb6fd93d58568d46634964b778bf68f3ccba4a3d`，不能以 baseline 的 HEAD 說明 current source。最初 52-path review manifest／diff 的 SHA-256 分別為
`dda65207fe64820f08d7e497ec755092c359821a68ba4e4fc91074dbc7e39490`／
`d3103d5d80e2e1b115f4ab09635923cf85ecd19d128eeb3fa9cd6c7fe21dda4b`；它固定在
Vitest／CORS 前，不能涵蓋 final delta。final5 `git diff --check` 通過；受保護 release 2461-file
hash map 再比對為 0 changed。工作樹另有使用者的 plan／work-card 修改，未納入 B03 source claim。

受保護 release 2461 hash map 位於 `/tmp/storeweave90-preserved-release-hashes.json`，至 CORS 後反覆驗證未變；
final3 preflight 也沒有新增 root release。B03 未做 persistent DB migration、API URL replacement 或外部寫入；B02
activation 除 getter 外未變。artifact 的 no-overwrite 是 publication safety，**不是** rollback certification。

## Historical checkpoint appendix

以下是 implementation chronology，不是現在的 TODO／ownership 描述；它保留用來追溯決策與早期失敗。

- Auth input slice 先完成 strict login／change-password validation；其 Sol review 僅覆蓋該 slice。後續 direct
  auth／Meta contracts、session metadata 與 MCP/Extension behavior 分別以真 HTTP tests 補齊，沒有改 guard、cookie
  或 CSRF policy。
- controller migration 依序處理 Inventory、simple Bus controllers、Content／Customer、composed register／image-keys／cart，
  再收斂 raw health、direct Auth/Meta、Extensions、MCP、callback、Storefront 與 static routes。這些早期 focused
  counts 是 checkpoint，不能替代 final3 full gate。
- startup/static review 發現並移除一個 stale `resolve` import；rate-limit review 的兩項 P2 已修正並關閉。HTTP
  transport 的 Sol Standards review 沒有 hard violation；接受兩個 P3 tradeoff：Auth／Meta／Extensions 保留五行 local
  input/response helpers，避免為 trivial duplication 擴大 export surface；既有 Commerce harness 同時保留 catalog
  assertions 與 real-wire behavior，不為此拆 test files。
- artifact review 在 numeric-like key lexical ordering 修正後 `CLOSED — PASS`；CORS review 先關閉缺失 P1，再在
  wildcard 與 raw parser corrections 後 `CLOSED — PASS`。這些結論不覆蓋 final full suite、Docker/native smoke 或
  B03 final independent review。
- 早先完整 integration 各有一個 180s timeout：`cli-legacy-upgrade` paired 與 `cli-upgrade-paired`（各 79 files／
  653 tests）；isolated legacy 2/2 95.4s、paired 1/1 82s。這是歷史 failure，不推翻 final3 的 79 files／655 tests
  pass。

## Closure

`cli-legacy-upgrade` 的單次紅燈在 crash hook 前退出，未證實產品 regression；不加入 retry 或放寬 SIGKILL
斷言。測試現在會在該 assertion 失敗時保留 `signal`、`code`、`killed` 與 `stderr`，而 final5 full gate 已通過。
B03 沒有 merchant DB migration、API URL replacement、release publication、commit、push 或 deploy。
