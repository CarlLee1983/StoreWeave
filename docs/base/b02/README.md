# B02 — 同一份 release 選取模組、設定與資料

狀態：done，2026-09-08。前置 [B01 已完成](../b01/README.md)；依 [B02 派工卡](../b00/next-work-cards.md#b02--同一份-release-選取模組設定與資料) 與 [Spec 0009](../../specs/0009-complete-modular-base.md) 執行。

最終驗收見 [需求與證據對照](acceptance.md)。以下依時間保留過程；早期 pending／finding 以最終對照及末段 closure 為準。

## 出口與邊界

Base-only 與 Commerce 共用版本化 release 選取來源，API／worker／CLI／seed／build 組裝一致。乾淨 Base 不 import／註冊／排程 Commerce、不要求商務 currency／provider／roles，DB 只有所選基礎及網站模組表。Commerce 既有 URL、descriptor、payload、SDK 與歷史資料保留；設定移轉須明確。

Migration 由 owner 管理 id／checksum／順序；鎖定須綁定單一連線或交易。拒絕未知歷史、重複 id、checksum drift、錯序；舊記錄建立可驗證基準，不重寫歷史 SQL。停用模組只保留唯讀 history metadata，重啟先驗證；尚有相依或未完成工作時不可移除，永不自動 DROP TABLE。另完成必要 seed 重跑、失敗逆序 cleanup 與有限時 shutdown drain。

## 執行順序

| 步驟 | 狀態 | Owner／驗證出口 |
| --- | --- | --- |
| 1. 決定最小 release／history Interface | done（主代理已整合，細節隨實作驗證） | Sol/high 風險分析；Terra/high 唯讀接線、設定、migrator 與生命週期盤點；主代理整合 |
| 2. 完成可運作的 Base／Commerce 組裝與資料移轉 | done（所有 audit findings 已修正並複查） | 主代理持有 production、共同設定／build／entrypoints／持久資料；不先留空接口 |
| 3. 驗證與操作文件 | done（完整回歸與四種 smoke 通過；最後修正另有聚焦回歸） | 真 PG base／commerce、並行 migration、故障／舊版升降版、seed、完整回歸、兩種 build 與隔離 smoke |
| 4. 獨立審查與結案 | done（全新 Sol/high Standards／Spec 皆通過） | 未參與實作的 Sol/high Standards／Spec；findings 收斂後才解鎖後續包 |

B03 承接完整 HTTP contribution／安全 transport 與文件；本包仍須交付能乾淨 build／bootstrap 的 Base API。B04 承接 Queue fencing／取消／retention；本包只做停用／移除與生命週期所需的既有工作狀態檢查，不宣稱完整 Queue 已完成。

## 基準與現況

- HEAD `1f4470d810a84fc43d97c1990c32c5e71608dd7f`；保留 81–90、B00–B01 未提交成果。
- B02 起始 732 檔快照：`/tmp/storeweave-base-b02-baseline-path`；B01 全檔 hash：`/tmp/storeweave-b01-complete-worktree-hashes.json`。
- B01 graph／metadata／scoped subscriber／transaction-aware public operations 已驗證；不能把它當成 B02 release 選取完成。
- 起始基準為固定 Commerce bootstrap／CommerceConfig 與 pooled migration lock。現已新增共用 bootstrap、Base／Commerce definition 與 BaseConfig，修正鎖；四個程序的 build 選取已接上，完整 history 尚未完成。
- 已開始單連線 migration 鎖修正；release／history 設計已交接並進入實作。第一片段型別檢查與真 PG 8 個測試 PASS；尚非 B02 全包驗收。
- Terra/high 唯讀接線盤點已完成，完整表格 `/tmp/storeweave-b02-dependency-inventory.txt`；Sol/high 設計已交接完成並關閉該 pane。
- 待保留的 Commerce 身分語意包含顧客 8／操作者 12 字元密碼規則、各自 session TTL、顧客 Actor.type。現有 staff／readonly 權限含可停用 ERP extension 的名稱，不能把未啟用 extension 的 permission 字串誤當成設定錯誤。

### 已核對的連線與鎖定限制

- PostgreSQL session advisory lock 在交易回滾後仍保留，直到同一 session 解鎖或結束；同 session 重入可成功並累計鎖次數。因此 migration 全程必須明確擁有連線。[PostgreSQL 17 官方文件](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)
- `pool.query` 使用當下可用 client，交易需使用同一個 checked-out client；結束必須 release，無法安全回收的 client 應銷毀。後續測試涵蓋同 pool 與不同 pool 的並行 migration、失敗後鎖釋放，保留既有逐 migration 成功前綴。[node-postgres transactions](https://node-postgres.com/features/transactions)、[pool API](https://node-postgres.com/apis/pool)

### 單連線 migration 片段

- `runMigrations` 明確接收 `pg.Pool`，checkout 一個 client 後加鎖，再建 history table、讀取及逐步套用 migration，最後同 client 解鎖。保留每個 migration 自己的交易及成功前綴；rollback／unlock 異常不得回收不確定的 client。runtime 與 B00 PoC 呼叫同步調整。
- `pnpm typecheck` PASS：`/tmp/storeweave-b02-lock-typecheck.log`。
- `pnpm exec vitest run --project integration tests/integration/migration-lock.test.ts tests/integration/module-consumers.test.ts`：2 files／8 PASS，`/tmp/storeweave-b02-lock-integration.log`。涵蓋同 pool／不同 pool cold start、成功前綴與失敗步驟回滾重跑、鎖遺失後 client 銷毀。
- checksum／未知歷史／舊版 baseline 已於後續片段實作；module version／disable-reenable／release 轉換仍待完成，不能視為完整 B02 migration contract。

### 已接受的 release／history 設計

Sol/high 交接完整來源：`/tmp/storeweave-b02-sol-design.txt`。採 build-time Base／Commerce release 與 HTTP／seed adapter；共用 bootstrap、角色政策、history catalog。Base 不載入 Commerce modules／theme／controllers／demo seed，並以 emitted metafile 驗證。Commerce 保留 v1 設定與既有角色／密碼／session 語意。

主代理收斂：角色型別由 authorization 持有，bundle 僅組裝；SQL checksum 由 catalog 邊界對精確 UTF-8 bytes 計算，避免每個 migration 同時維護重複欄位；通用 extensions 設定保留空預設，是否可啟用由所選 release 決定。

新 history metadata 採 additive 欄位／表；舊三欄記錄須明確 CLI baseline，記錄所採 catalog 與操作者來源，不能聲稱可證明歷史 SQL bytes。停用以 prior-release 的純資料 pins 與工作 owner 清單驗證；轉換前停止舊 API／worker，拒絕依賴、未完成或未知工作，保留資料不自動 DROP。完整 queue fencing 留給 B04。

後續實作順序：release/config/roles → API/worker/CLI/seed/build 共用選取 → history/checksum/baseline → disable/re-enable → reverse cleanup 與單一 shutdown deadline → 升降版／雙 release smoke／完整回歸／獨立 Sol 審查。

### 設定／角色與 bootstrap 片段

- `authorization` 提供 release role catalog；runtime 必須明確傳入，identity／session／password reset 共同使用。Base 無 Commerce role grants；Commerce 保留既有權限（含未啟用 ERP 的 dormant 權限）、顧客 8／操作者 12 字元與 TTL／Actor.type。未選入角色不可登入、解析 session 或重設密碼；token policy 在 DB 建構前驗證。
- Base／Commerce schema 共用欄位；Base 不含 currency，Admin／MCP 預設關閉、theme none，通用 extensions 預設空。新增通用 loader、Base JSON Schema 與 `deployments/storeweave.example.yaml`；Commerce 保留 v1 與 COMMERCE_CONFIG，STOREWEAVE_CONFIG 優先。明確指定但不存在的路徑現在失敗，不會悄悄改用另一份設定／DB。
- `shutdown.timeoutMs` 預設 25,000；API／worker 已接單一程序 deadline，library cleanup 亦有限時；完整產物啟停／升降版仍待驗。
- 新 `ReleaseDefinition`、Base／Commerce definitions 與 `bootstrapRelease`，舊 Commerce bootstrap 已轉接；API／worker／CLI／seed 的 build-selected adapter 已接上。
- 型別檢查 PASS：`/tmp/storeweave-b02-roles-typecheck.log`、`/tmp/storeweave-b02-release-typecheck.log`。
- 單元 50 files／577 PASS：`/tmp/storeweave-b02-roles-unit.log`；角色／identity／customer 26 PASS：`/tmp/storeweave-b02-roles-integration.log`；password-reset／auth-http／noncommerce 42 PASS：`/tmp/storeweave-b02-roles-auth-regression.log`；最終 Base config／roles 8 PASS：`/tmp/storeweave-b02-base-config-roles-final.log`。
- 獨立 Sol/high 角色／設定審查 scoped PASS，結果 `/tmp/storeweave-b02-roles-review-final.txt`；固定 8 檔 hash：`/tmp/storeweave-b02-roles-review-hashes.json`；此審查不代替整個 B02 最終 Standards／Spec。

- Base／Commerce 共用 bootstrap 真 PG 2 PASS：`/tmp/storeweave-b02-release-bootstrap.log`。Base 精確 11 個平台／Identity table、3 個平台 module、3 個 Base role，無 currency／theme，migration 重跑不新增；Commerce 17 modules／default theme／catalog table 保留。初輪測試誤寫商品表名稱，已依實際 migration 修正為 `catalog_products` 後通過；未改 domain SQL。

### HTTP／四程序 build 與必要 seed

- Base／Commerce HTTP adapter 各自選 controllers／匿名角色／session hook，Commerce 保留購物車合併。Bearer token 與匿名身分改用 runtime release catalog；tokenAllowed 亦在請求邊界核對。Base 實測無 Commerce routes／theme assets。審查指出的舊全域 HTTP role lookup 已修正，HTTP 回歸 4 files／52 PASS：`/tmp/storeweave-b02-http-regression.log`。
- `scripts/releases.mjs` 一次選取 API／worker／CLI／seed 的 runtime／HTTP／seed adapter；預設 Commerce，`STOREWEAVE_RELEASE=base` 選 Base。四份 bundle 都寫 esbuild metafile，Base 拒絕 Commerce packages／extensions／theme／adapters。開發 TS alias 預設 Commerce；Base 須使用選定 release 的建置產物。
- CLI 的設定／資料／log／pid／service 名稱跟隨所選 release；Commerce 預設不變，Base 使用 storeweave 路徑與服務名稱。未對外啟停任何既有服務。
- `seed` 預設只 migrate／persist extension registry，可重跑；Commerce 示範資料移至 `scripts/seeds/commerce.ts`，須明確 `pnpm seed -- --demo`。Base `--demo` 明確失敗。README／Demo Guide 已同步，schema 與 seed 原始碼納入型別檢查。
- 兩種四程序產物建置 PASS（Commerce 本輪 `--skip-admin`）：`/tmp/storeweave-b02-build-base-01.log`、`/tmp/storeweave-b02-build-commerce-01.log`；產物分別在同名 `/tmp/...-01` 目錄，根 dist／release 未覆蓋。CLI 後續 service 名稱與版本注入已由最新產物測試重建驗證。
- 真 PG 產物測試 2 PASS：`/tmp/storeweave-b02-artifacts.log`。測試各自重新 build，檢查四份 metafile、必要 seed 兩次、CLI migrate、worker disabled 退出與無 demo rows。這不是已啟用 worker／API child process 的完整 smoke；完整啟停／故障／升降版仍待驗。
- 單元 50 files／577 PASS：`/tmp/storeweave-b02-http-unit.log`；初輪 theme asset 測試缺新的 runtime actor stub，補上平台匿名角色邊界後通過。
- `STOREWEAVE_BUILD_DIR` 可指定全新輸出目錄做隔離建置；若目錄已存在即拒絕，避免覆蓋先前產物。

- 最終四程序產物測試再跑 2 PASS（含 service 選取修改），並以 `0.1.2-test` 核對 build-info 與獨立 CLI process 的版本一致；build 將 release version 注入所有 bundles。型別檢查 PASS：`/tmp/storeweave-b02-entrypoints-typecheck.log`。Seed 新納入 typecheck 後修正原本錯從 kernel 匯入 Actor 的型別引用，改取 contracts。

### Migration checksum／順序與舊記錄 baseline

- Migration catalog 以精確 UTF-8 SQL bytes 計算 SHA-256，逐 owner 記錄 1 起算的順序。先拒絕重複 owner／id、來源錯序，再取得連線。status 與 migrate 都鎖住同一 session，驗證未知記錄、phase／checksum／順序 drift 與非連續已套用前綴，才執行尚未套用的 SQL。仍是每個 migration 自己提交，失敗保留成功前綴。
- `platform_migrations` 只新增 nullable checksum／migration_order／legacy_baseline_id，另有平台持有的 `platform_migration_baselines`。舊三欄 INSERT 仍可成立，新版遇到空 metadata 明確拒絕；Base 現有 metadata 加入後為 12 個平台／Identity 表。沒有改寫任何 domain migration SQL。
- 固定 `legacy-commerce-0.1.0-pre-b02` catalog 由 B02 起始快照產生：`packages/platform/bundle/src/legacy/commerce-pre-b02.json` 記錄 16 個來源檔 SHA-256 與 49 個 migration pins。與目前 16 檔 SQL bytes 核對一致。Base release 不載入此 Commerce legacy catalog。
- `baselineMigrations` 只採納完全匹配所選 catalog 的舊行，檢查 owner 前綴及時間證據；同一交易寫入 catalog digest／來源 release／操作者 evidence 與所有回填行。任何一步失敗全部回滾；再次執行沒有舊行則不新增 baseline。回傳 `historicalSqlVerified: false`：證明採納哪份 catalog 與保護後續 drift，不能證明歷史曾執行相同 SQL bytes，也不宣稱能推知全域歷史順序。
- API／啟用的 worker 啟動前檢查 history 及 pending migrations；必要 seed 直接走驗證後 migrate。CLI baseline 是明確獨立操作，沒有自動採納或略過驗證旗標。

操作流程（本包完整升降版／rollback gate 仍待驗證）：先保存來源 release 與 DB snapshot，停止舊 API／worker，核對固定 catalog 是否對應來源資料庫，再執行：

```bash
pnpm commerce migrate --status
pnpm commerce migrate baseline --catalog legacy-commerce-0.1.0-pre-b02 --evidence '操作者、來源 release 與備份驗證紀錄'
pnpm commerce migrate
```

不要把 baseline 當作修復未知／缺號／phase 不一致歷史的工具；它會拒絕這些狀況。沒有自動 down migration／刪除 history／DROP data。停用 history pins、module version、release manifest 與舊 binary 實測仍是本包剩餘工作。

- 型別檢查 PASS：`/tmp/storeweave-b02-history-typecheck.log`；單元 50 files／577 PASS：`/tmp/storeweave-b02-history-unit.log`。
- History／baseline 14、lock 4、Base release 3 個真 PG 測試 PASS，`/tmp/storeweave-b02-history-integration.log`。同輪兩個產物測試因 CLI import 放在 shebang 前失敗；修正後獨立重跑 2 PASS：`/tmp/storeweave-b02-history-artifacts.log`，包括實際 CLI 明確採納 49 行並再次 migrate。
- CLI legacy 測試明確以清空 metadata 建立舊行 fixture；它不等同已完成舊 binary smoke。基礎 baseline tests 另從真三欄舊 table／SQL 建起，涵蓋不一致拒絕、證據保留、原時間不變及更新中途失敗的全交易回滾。

- 後續真 backend termination fault 測試曾出現 5 assertions PASS 但 1 個未處理 socket error，未視為通過。已依 pg 實際 client 事件生命週期修正：migrator 持有期間監聽 error，保留失敗，丟棄連線時直到 end 才移除 listener。重跑 lock／斷線 5 PASS、無未處理事件：`/tmp/storeweave-b02-history-disconnect.log`；另驗證第二個 pool 可重跑失敗步驟，先前已提交步驟保留。最終 typecheck PASS。

### 初始化失敗與 shutdown 片段

- ExtensionRegistration 新增選用 close；既有 extensions 無須更動。setup 若尚未回傳就失敗，須自己釋放已取得的資源；回傳後若 manifest／registration 失敗，host 立即清理。host.close 等待已開始的 mount，依成功掛載順序反向清理，每個只清一次，拒絕後續 mount。
- runtime 的所有 post-DB 初始化失敗都走 extension → DB 的清理路徑。close 保留同一個 promise，可重複／同時呼叫；某個 cleanup 拋錯仍嘗試其他資源，以 AggregateError 保留原始與清理錯誤。
- HTTP creation 設 abortOnError false，讓 controller 建構失敗可以回傳給外層；未取得 app 時關閉 Fastify adapter，取得後的 register／init 失敗關閉 app。API listen／worker 啟動失敗亦逆序清理。
- API／worker 完成啟動後，SIGTERM／SIGINT 使用共用 installShutdown，第一個 signal 啟動單一 hard-exit deadline，重複 signal 不重複 cleanup。worker 停止 timer／intake，只等待目前 tick；超時 exit 1，沒有把未完成 job 宣稱成功。library cleanup timeout 會拒絕；它不取消未合作的 Promise，程序 hard deadline 才是最終退出保證。
- lifecycle 單元 3 PASS（含真 child process、hung worker tick 與重複 signal）：`/tmp/storeweave-b02-lifecycle-unit.log`。fixture 用 active interval 代表未完成外部資源，先觀察 shutdown handler 進入再送第二個 signal；它不是完整 Queue 崩潰／恢復測試。
- 初輪 runtime／Base 整合 7 PASS：`/tmp/storeweave-b02-lifecycle-integration.log`；補上 HTTP failure 後 runtime lifecycle 6 PASS：`/tmp/storeweave-b02-lifecycle-failure.log`，確認已連線 pool 關閉、逆序與錯誤保留、concurrent mount、controller construction／app.init 清理。
- 全單元 51 files／580 PASS：`/tmp/storeweave-b02-lifecycle-full-unit.log`；最終型別檢查 PASS：`/tmp/storeweave-b02-lifecycle-typecheck.log`。
- bootstrap 現在持有 file logger，正常關閉依序清理 runtime（extensions／DB）再 flush／close logger；初始化失敗也清理 logger，保留原始與清理錯誤。child logger 共用資源但沒有 close，呼叫端提供的 stream 不由 runtime 關閉。
- 真檔案測試發現 SonicBoom 開檔失敗不會發出 close；改以 ready／error／close 公開事件區分未取得 descriptor 與已開檔資源，避免永久等待，也不依賴未公開的 destroyed 型別。聚焦 logger／lifecycle 8 PASS：`/tmp/storeweave-b02-logger-unit.log`；型別檢查 PASS：`/tmp/storeweave-b02-logger-typecheck.log`。
- 全單元 52 files／585 PASS：`/tmp/storeweave-b02-logger-full-unit.log`。隨後追加 shutdown logger 自身拋錯的真 child process 回歸，lifecycle 4 PASS：`/tmp/storeweave-b02-logger-shutdown.log`，確認 hard deadline 先建立，logging failure 不阻止 cleanup／exit。
- 待完成：真正 API／worker 產物啟停／故障 smoke、module version／停用重啟／release manifest、完整升降版與獨立最終審查。不能以本片段關閉 B02。

### 獨立程序 smoke

- `release-artifacts.test.ts` 擴充為 Base／Commerce 各自重建四份 bundle，在隔離真 PG 上必要 seed 重跑後，實際啟動 API 與啟用的 worker，HTTP liveness 200，SIGTERM 後兩者 exit 0。再啟動第二個 API 造成 EADDRINUSE，驗證初始化後 listen 失敗能清理並 exit 1，原 API 仍可用。
- 2 個端到端案例 PASS：`/tmp/storeweave-b02-process-smoke.log`；型別檢查 PASS：`/tmp/storeweave-b02-process-typecheck.log`。測試有程序強制清理與總期限，不把被測程序 timeout 當成功。此次仍是 Node application bundles，Native／Docker 包裝、實際 job 中斷復原及舊版 binary 回復尚未完成。
- 既有 release 的 2461 個檔案 SHA-256 再次核對，全部保留；未安裝或啟停既有服務。

### 舊 binary 回復與包裝接線（進行中）

- 使用保留的 B01 bundle（`/tmp/storeweave-b01-build-path`）在獨立 PG 容器由舊 CLI 建立 49 筆 migration，插入商品，再依序啟動舊 API、新版 baseline／migrate／API、舊版 migrate／API。全部 PASS，原 id／phase／applied_at 與商品內容不變：`/tmp/storeweave-b02-old-binary-probe.log`；可重跑探針：`/tmp/storeweave-b02-old-binary-probe.cjs`。這只證明目前 checksum／baseline metadata 的 additive 變更可回復；module history／manifest 尚未實作，完成後必須再驗，不能外推至任意 data version 降版。
- Commerce 完整 Vite build 現在直接寫入選定輸出的 admin/，不再先覆蓋 apps/admin/dist。明確 `--skip-admin` 仍沿用既有已建 Admin 的行為。完整 Base／Commerce 四程序＋assets＋啟停測試 2 PASS：`/tmp/storeweave-b02-full-artifact-smoke.log`；Admin 26 files／314 PASS：`/tmp/storeweave-b02-admin.log`。
- Terra/high 包裝盤點：`/tmp/storeweave-b02-packaging-inventory.txt`。同 pane 完成 `scripts/smoke-base.sh`，只讀健康／授權平台端點與實際 Commerce URL 的 404，curl 有期限且失敗退出，無共用暫存檔。syntax／成功與錯誤 mock 證据：`/tmp/storeweave-b02-base-smoke-check.txt`；真 Base bundle 接線驗證進行中。
- Native build 接受 `STOREWEAVE_RELEASE`、`STOREWEAVE_BUILD_DIR`、`STOREWEAVE_RELEASE_DIR`，Base 使用 storeweave 名稱與獨立 config／systemd assets，Commerce 路徑保留。兩種 tarball 已成功產出：`/tmp/storeweave-b02-native-path`；build logs `/tmp/storeweave-b02-native-base-build.log`、`/tmp/storeweave-b02-native-commerce-build.log`。本機無 dpkg-deb，尚未驗證 .deb。
- 新版 native installer 驗證 release marker／build-info／四程序存在，拒絕覆寫既有版本，設定範本完成後才原子切換 current。新建 env 檔 root:release-group／0640，讓 service account 能讀 file secrets；不改既有 env 權限。Native smoke 改用唯一容器／network 與全新輸出路徑，只清理由該次建立的物件，實測相同版本重裝拒絕並以服務帳號執行 install／start。
- Base smoke 腳本已在真 API／worker 產物上通過；兩種完整產物案例再跑 2 PASS：`/tmp/storeweave-b02-base-script-smoke.log`。包裝聚焦 unit 2 PASS：`/tmp/storeweave-b02-packaging-unit.log`；型別檢查 PASS：`/tmp/storeweave-b02-packaging-typecheck.log`。
- Native Base 首輪在服務帳號讀取連線設定時失敗：Base YAML 缺少 file secret provider 宣告，而 schema 正確預設只讀 env。已補上部署範本及 smoke config 的 `secrets.provider: file`，不改 schema 的既有 env 語意。Base 重跑 PASS（10 項 HTTP checks）：`/tmp/storeweave-b02-native-base-smoke-r2.log`；Commerce PASS（61 項 checks）：`/tmp/storeweave-b02-native-commerce-smoke.log`。两者使用內附 Node，在非 root 服務帳號下 install／start／stop，重裝同版本拒絕，測試容器由 harness 清理。Docker release 選取與完整隔離 smoke 尚待完成。上述 installer／包裝修改尚待獨立 Sol/high 最終審查。
- Manifest 額外 Sol/high 設計：`/tmp/storeweave-b02-manifest-design.txt`。採用 extension registeredJobs 宣告、DB 保存唯讀停用 pins 與分階段 activation；主代理正收斂型別 ownership、避免重複 module catalog／current-state table。尚未把設計視為已實作。

### Extension job 宣告

- SDK 新增可省略的 `registeredJobs`（空清單預設）；有 jobs 的 extension 必須明確列出，host 在註冊任何 handler 前比對，失敗沿用 setup cleanup。MountedExtension 回傳實際 jobs；離線 contract checks 同樣核對宣告。Demo ERP／ECPay Logistics 保留既有 job type，補上宣告；Extension Guide 與 Gift Wrap 範例同步。
- 契約單元 15 PASS：`/tmp/storeweave-b02-job-manifest-unit.log`；真 PG lifecycle／ERP 流程 17 PASS：`/tmp/storeweave-b02-job-manifest-integration.log`；型別檢查 PASS：`/tmp/storeweave-b02-job-manifest-typecheck.log`。本片段之後仍須重新建置最終 native/Docker 產物。
- Sol/high 修訂已接受：DB 中立的 pin/work/effective 型別由 db 持有；將現有 module factory 的純函式、metadata 不受 config/provider 狀態影響規則明文化，build/runtime 共用投影並比對；只增加 append-only release history，不建立重複的 module current-state table。完整 manifest／history orchestration 尚待實作。

### Docker release 選取

- Dockerfile 的 `STOREWEAVE_RELEASE` build arg 決定四程序、config 範本、OS 身分與路徑。runtime image 只複製選定輸出；entrypoint 讀 image 內固定 marker，環境變數不能把 Commerce binary 變成 Base。Base 使用 storeweave 路徑，Commerce 保留 /opt/commerce、/etc/commerce 與既有 UID/GID 999（已由先前 image 的 id 指令核對）。新增 seed entrypoint；必要 seed 可重跑。
- `compose.base.yaml` 是 Base 獨立樣例，既有 compose.yaml 保留 Commerce 預設，兩者支援測試專用 image tag。Docker smoke 改用唯一 project／tag，拒絕任何同名既有 container（包含已停止）、network、volume，只清理該次 Compose project。`.cache` 排除於 Docker context。
- Base image build PASS：`/tmp/storeweave-b02-docker-base-build.log`。Base Docker smoke PASS（10 項 HTTP checks、兩次必要 seed、image 無 Commerce paths／Admin／theme）：`/tmp/storeweave-b02-docker-base-smoke.log`。Commerce Docker smoke PASS（62 項、兩次必要 seed）：`/tmp/storeweave-b02-docker-commerce-smoke.log`。測試容器已清理，六個既有 dbcli 容器仍健康。
- Docker/native staging 聚焦 unit 2 PASS：`/tmp/storeweave-b02-docker-unit.log`；Compose config 與四份 shell syntax 通過。Native build 另拒絕覆寫既有 tar／deb／deb staging，接受合法 prerelease＋build metadata version。
- 完整 B02 仍需 manifest／history 接線後的最終產物重建、完整 integration、獨立 Sol/high 審查；本機未驗證 .deb 安裝。
- 本輪全單元 52 files／587 PASS：`/tmp/storeweave-b02-packaging-full-unit.log`。既有 release 2461 個檔案 SHA-256 再核對無變更。

### Build manifest 與啟動前比對

- `composeRuntimeModules` 共用既有 platform／ops／identity 組裝與 graph validation。Release 明列非機密 `manifestConfig`，用 schema.parse 建立 build-only 設定；module factory 必須同步、純建構，config/providers 只可由 handlers 捕捉，不能改變 graph／migration／work metadata。
- `release-manifest.ts` 將 module versions／依賴／table ownership／精確 SQL checksum 與順序投影為 SQL-free pins，包含 migrationless ops；extension 只讀 manifest 宣告，available 不代表 enabled，完全不呼叫 setup。DB 中立型別與 canonical SHA-256／work owner 唯一性檢查在 db；未新增 runtime registry。
- Build 先產出 `release-manifest.json` 與 emitter metafile，再將 checksum 固定到四個程序。Base forbidden-import gate 同樣套用 emitter。bootstrap 在 DB 建構前比較實際 config 的 module 投影與 build-only 投影，再核對編入的 checksum；metadata drift 直接失敗。Native tar 納入 manifest／emitter graph，installer 亦驗證 manifest digest／release id／version。
- 聚焦 manifest 4 PASS：`/tmp/storeweave-b02-manifest-unit.log`；Base／Commerce 真 PG 與四程序產物 5 PASS：`/tmp/storeweave-b02-manifest-artifacts.log`。加入四個 bundle 固定 checksum 檢查後，產物／lifecycle 9 PASS：`/tmp/storeweave-b02-manifest-pinned-artifacts.log`。型別檢查 PASS：`/tmp/storeweave-b02-manifest-typecheck.log`；全單元 53 files／591 PASS：`/tmp/storeweave-b02-manifest-full-unit.log`。
- 另追加 checksum 不符時 DB 尚未建構的回歸，聚焦 5 PASS：`/tmp/storeweave-b02-manifest-checksum-unit.log`。Native 新版先竄改 manifest 拒絕安裝、還原後完成 Base smoke PASS：`/tmp/storeweave-b02-manifest-native-smoke.log`。該次安裝輸出揭露 Base CLI 仍提示 commerce start，已將 CLI 提示／help／程序 logger 名稱改為選定 release 的命令名稱；屬文字接線，最終產物仍須整包重建。
- 尚未持久化 effective manifest。下一片段依 Sol 修訂實作 append-only release history、disabled pins、版本／資料核對與兩階段 activation。工作檢查亦須拒絕仍有待處理工作的 handler／event 被移除，即使 owner 模組本身仍保持 active；不能只檢查整個 owner 的停用。

### Effective history 資料層（尚未接上 runtime 啟用）

- 新增平台持有的 append-only `platform_release_history`，記錄 effective JSON／SHA-256／release 與 Base version；module versions／active-disabled 狀態直接在 JSON 保留，不再建立重複 current-state table。platform_migrations 加 nullable owner／local id／module version／release provenance，保留舊三欄寫入；既有 domain migration SQL 未改。Base metadata 表目前為 13 個。
- `prepareRelease` 驗證 active SQL 與 pins 一致、接回上次 disabled pins、拒絕版本降級／owner 變更／舊 pins 改寫／依賴缺失／缺少歷史或已保存的表，並檢查待處理工作，才逐 migration 提交。只驗證 saved tables／migration pins，不宣稱已驗證全部資料列或實體欄位 fingerprint。
- `recordEffectiveRelease` 再取同一種 session lock，核對 setup 後的 manifest 與 preparation checksum，拒絕中途不同 release，重驗 history／tables／work後才寫一筆 release row。同一目標並行提交只新增一筆；任何 setup 尚未成功的 preparation 不會記成 effective。舊 writers 必須先停止；這不是 Queue producer fencing。
- 檢查 pending／running／dead direct jobs 與 event deliveries，以及 pending／dead outbox。未知 type／subscriber／emitter、移除現有 subscription、停用 owner 或移除 active owner 的 work 都拒絕；completed／relayed 不阻擋。禁用 pins 不含 SQL、不執行 migration，跨 Base ABI 仍可保留舊 extension 的唯讀證據。
- 第一輪真 PG lock／migration／Base／transition 36 PASS：`/tmp/storeweave-b02-release-transition.log`。補上 SQL prefix failure/retry、disabled extension ABI 與 manifest corruption 後 transition 17 PASS：`/tmp/storeweave-b02-release-transition-extra.log`；型別檢查 PASS：`/tmp/storeweave-b02-release-history-typecheck.log`。
- Sol/high 正在唯讀審查資料層，報告目標 `/tmp/storeweave-b02-release-history-review.txt`。Runtime 延後 extension setup、正式 activate、CLI status／baseline 與舊 catalog 的 module/extension pins 尚未整合；不能以資料層測試宣稱 B02 停用／重啟已端到端完成。
- 本輪全單元 53 files／592 PASS：`/tmp/storeweave-b02-release-history-full-unit.log`。鎖與單連線內部 helpers 不從 db package 主入口匯出，對外的 migration／release 操作均自行取得鎖。

### 資料層審查修正（B02 仍進行中）

- Sol/high 審查 `/tmp/storeweave-b02-release-history-review.txt` 判定 NEEDS WORK：finalizer ABA、legacy baseline 缺 effective history、已停用 subscriber 誤擋後續 outbox，以及 persisted v1 與設計型別不一致。
- 已修正 ABA：同一 advisory lock 內核對 preparation sequence 之後的全部 history，任何不同 checksum 都拒絕舊 finalizer；相同 predecessor／target 的並行 finalizers 仍冪等。Outbox 僅保護前一 effective state 為 active 的 subscription，已停用者不再被視為本次移除。
- 真 PostgreSQL transition 20 PASS（包含 ABA、pending／dead outbox 新回歸及既有並行冪等／移除阻擋）：`/tmp/storeweave-b02-history-review-fixes.log`。Typecheck PASS：`/tmp/storeweave-b02-history-review-fixes-typecheck.log`；git diff --check PASS。
- 同一 Sol/high 審查者正複核這兩項並收斂 DB-neutral v1 格式，保留 table ownership 證據與 owner-local migration ids 的邊界。Legacy baseline 原子採納、runtime／CLI activation 接線仍未完成；沒有將本片段視為 B02 完成。

### DB-neutral pins 與 release status

- Build-only 的 Base／extension compatibility range 與依賴欄位移到 bundle 的 BuildModuleManifest／BuildExtensionManifest；DB strict schema 不接受這些 graph 欄位。Kernel 既有 pre-DB graph 驗證保留。DB ModulePin 保存 tables 作為資料 ownership 證據、owner-local migration ids；ExtensionPin 明確為空 migrations tuple。實體 SQL ledger 仍使用 owner/id，由 DB 邊界組合。
- 真 PG 驗證 persisted v1 JSON round-trip、停用 pins 保留、qualified id／graph 欄位拒絕；同跑舊 migration history 共 35 PASS：`/tmp/storeweave-b02-neutral-pins-integration.log`。Manifest／graph 16 PASS：`/tmp/storeweave-b02-neutral-pins-unit.log`，涵蓋 missing dependency 在 DB 存取前失敗。
- 新增 releaseMigrationStatus：讀取 active＋retained history，僅列 active pending SQL，另回傳 releaseCurrent 以辨識 migrationless 轉換；不執行 domain SQL／setup／effective history append。Cold status、migrationless pending 與 disabled history 連同 transition 22 PASS：`/tmp/storeweave-b02-release-status-integration.log`。
- 全單元 53 files／592 PASS：`/tmp/storeweave-b02-neutral-pins-full-unit.log`；typecheck PASS：`/tmp/storeweave-b02-release-status-typecheck.log`；git diff --check PASS。Build manifest 格式因此改變，完整 runtime 接線後仍須重建最終產物。
- Terra/high `legacyinventoryb02` 正唯讀核對 B01 snapshot 的 module／extension metadata，供固定 legacy catalog 採納；不能以目前的 runtime metadata 冒充歷史。Sol/high `historyreviewb02` 持續複核與 baseline 交易設計。B02 仍未完成。

### 原子 legacy effective baseline（2026-09-08）

- SQL-only baseline 已由 release-history 的單一 manifest 採納取代；沒有第二份 top-level migration pins。驗證所有固定 SQL pins／資料關聯／工作後，同一 locked client 的一個 transaction 寫 baseline、全部 migration provenance、effective history。原 id／phase／applied_at 不改，採納不執行 SQL migration。Checksum 已存在仍會補完整採納；已存在不同 effective history 則拒絕。
- `historical_sql_verified=false` 與 `historical_runtime_verified=false` 永久存於 baseline，migration 與 release history 關聯到該證據。重跑核對完整 metadata／關聯，不能只看本次 adopted 行数。既有舊 SQL-only baseline 可以採納 effective history，原始 evidence row 保留；失敗整筆回滾。
- Commerce 固定 catalog 現含 17 modules、8 個已知 extensions、49 個 owner-local pins；94 個歷史來源 SHA-256 均由 B01 snapshot 核對。Terra inventory：`/tmp/storeweave-b02-old-owner-inventory.json`。主代理逐欄與目前純投影比對，唯一 ownership 差異是 B02 新增的兩張 metadata 表，未寫成舊平台表。Catalog 的 buildManifestChecksum 是來源 hashes／固定 owners 的重建摘要，不是聲稱舊 binary 曾發出該 manifest。
- 舊 extension 的歷史啟用狀態無法從 source 證明。CLI 傳入目前設定啟用的 ids；其他已知 extensions 保留 disabled pins，未知啟用項目拒絕。採納前對所有已知舊 subscriber 保守檢查 pending／dead outbox，不能靠停用設定忽略可能未交付的事件。
- `ModulePin.dataRelations` 取代原 tables 名称：既有 order module 擁有 `order_number_seq`，所以透過 pg_class 核對 ordinary／partitioned tables 與 sequences。這只驗證已保存資料關聯存在，不是欄位／資料內容 fingerprint。停用／重啟保留 sequence 值，缺少 sequence 明確失敗。
- Sol/high scoped review 無新增實作缺陷：`/tmp/storeweave-b02-baseline-sol-review.txt`。其指出的舊 baseline 關聯回歸已補；migration history 17 PASS：`/tmp/storeweave-b02-baseline-old-association.log`。完整 Commerce 三欄 fixture 採納→Base、商品／sequence 保留、保守 extension work、transition 共 26 PASS：`/tmp/storeweave-b02-baseline-commerce-integration.log`。這是隔離真 PG fixture，舊 binary probe 仍須在 runtime 接線後重跑。
- 尚未完成 runtime 延後 setup／activate 與 API／worker／CLI gates；CLI 雖已傳入 enabled ids，仍沿用舊 bootstrap setup 時機。接下來必須把 setup 移到 prepare 成功後，再做最終產物重建／完整回歸；不能以本片段宣稱 B02 端到端完成。
- 本片段最終 typecheck PASS：`/tmp/storeweave-b02-baseline-final-typecheck.log`；全單元 53 files／592 PASS：`/tmp/storeweave-b02-baseline-final-unit.log`。git diff --check PASS；原 release 2461 個檔案 SHA-256 全部不變。

### Runtime activation 接線（2026-09-08，待獨立審查）

- Kernel `release-pins.ts` 共用 SQL-free module／extension 投影，bundle 只加 build graph 欄位。RuntimeOptions 必須提供 release id／version／build checksum，bootstrap 傳入已核對的 artifact manifest；測試 fixture 明列自己的 release 身分。
- Runtime 建構不再執行 extension setup。`activateRelease('apply'|'require-current')` 依序 prepare→mount→實際 job／subscription 投影→registry→record effective，任何失敗都呼叫可包含 bootstrap logger 的 runtime.close。`migrate` 使用 apply，重複呼叫不再回報之前已執行的 SQL；close 後不可重新啟用。
- API autoMigrate 用 apply，其他 API／啟用的 worker 使用 require-current；停用 worker 直接清理退出。CLI user:create／extension:list 要求 current，doctor 回報啟用失敗；status／baseline／backup／restore 保持未啟用。Health 亦辨識無 SQL 但尚未 current 的 release；seed 由同一 migrate 啟用，不再重複 registry 寫入。
- 首輪整合 17 PASS：`/tmp/storeweave-b02-runtime-activation-integration.log`。新增 setup 延後／require-current、同目標重啟冪等、setup 失敗保留 migration 但無 effective history、未知待處理工作在 setup／SQL 前拒絕，lifecycle 9 PASS：`/tmp/storeweave-b02-runtime-preflight-regression.log`。初次新增測試誤把 Identity 兩個 migration 算成三個，已改核對實際兩個 id。
- 原 CLI JSON 單元測試假設 extension:list 不連 DB；新契約需先啟用，已移到隔離 PG integration 並保留 stdout JSON／stderr logs 驗證。全單元 52 files／591 PASS：`/tmp/storeweave-b02-runtime-activation-unit-r2.log`。Typecheck PASS：`/tmp/storeweave-b02-runtime-final-typecheck.log`。
- Base／Commerce 四程序重建與 smoke 2 PASS：`/tmp/storeweave-b02-runtime-artifacts-r2.log`。現代 history corruption 必須拒絕 legacy baseline；測試只在 disposable DB 將 metadata 重設成真舊三欄 shape，再驗證 CLI 採納兩個 unverified flags。沒有放寬 production corruption checks。
- 全 integration 67 files／574 PASS：`/tmp/storeweave-b02-runtime-full-integration.log`；新增最後一個 preflight case 另由上述 lifecycle 9 PASS 覆蓋。Sol/high `activationreviewb02`（Herdr wA:p1Y）正唯讀審查，不能以此關閉 B02；完整 native／Docker、舊 binary rollback、真 job crash recovery 與最終操作文件／雙軸審查仍待完成。

### Managed-process drain 與升級順序（2026-09-08）

- PID 模式 stopServices 改為 async：先驗證正整數 PID、對管理中的程序送 SIGTERM，再等待真正退出；逾時拒絕並保留 PID 檔。只把 ESRCH 視為已結束，權限錯誤不再偽裝成 stopped；刪 PID 檔前確認沒有被換成新程序。Restart／upgrade／rollback 呼叫端同步 await。
- Upgrade 現在等待舊 API／worker 停止後才 migrate，`--no-restart` 仍停止舊 writers；拒絕覆寫既有 target，使用選定 release 的 tar 名稱與 bin/CLI。current 用同目錄唯一 temporary symlink＋rename 原子切換，失敗訊息列出實際 current，不再一律宣稱保持舊版。尚未完成 candidate 驗證、incoming staging、snapshot 與 rollback 保護，不能視為完整安全升級。
- 真子程序與暫存目錄測試 8 PASS：`/tmp/storeweave-b02-upgrade-order-unit.log`，涵蓋 drain 後才 migrate、不重啟、既有 target／current 保留、stop timeout 與非法 PID 不送 signal。全單元 54 files／599 PASS：`/tmp/storeweave-b02-upgrade-full-unit.log`；typecheck PASS：`/tmp/storeweave-b02-upgrade-final-typecheck.log`。未操作既有服務。
- Terra/high 新增 `worker-recovery.test.ts` 與專用 fixture，真 PG／child Worker 證明 running attempt 1 經 SIGTERM hard deadline exit 1 或 SIGKILL 後仍未完成；相同 release 重啟，實際等候短 lease 過期後完成 attempt 2。聚焦 2 PASS：`/tmp/storeweave-b02-worker-recovery-final.log`。主代理核對 DB assertions 與 signal／exit 行為，要求補上的 spawn error／exit 等待期限已完成；不宣稱 exactly-once 外部副作用或 producer fencing。
- Sol/high activation 審查：`/tmp/storeweave-b02-activation-sol-review.txt`。仍有三項 P1：compatibility registry 與 finalizer 的原子性、upgrade candidate／snapshot 證據、rollback 僅切 symlink 與 downgrade policy 矛盾。Sol 正評估同一 DB transaction 寫 registry＋history，以及安全 tar staging 的最小實作；主代理持續處理，B02 未完成。

### Registry／effective history 原子提交（2026-09-08）

- Finalizer 接收純資料 ExtensionRegistryEntry，DB 存取前驗證恰好包含所有 active extension ids／versions、唯一性與欄位。Runtime 從實際 mounted 結果投影，permissions 排序去重；移除已無其他 caller 的 ExtensionHost.persistRegistry，避免保留第二條非原子寫入路徑。
- 同一 advisory-lock client 在 BEGIN 後檢查 CAS／ABA／history／資料／待處理工作，再一起 upsert compatibility registry 與 append effective history。任一寫入失敗都 rollback；同目標重試仍同步 registry，但不增加 history。Registry 是 last-seen compatibility metadata，active／disabled 只以 effective history 為準，停用 rows 不刪。
- 真 PG 39 PASS：`/tmp/storeweave-b02-registry-final-integration.log`。涵蓋 history insert 失敗不留 registry、後一 registry row 失敗回滾前一 row、修復後重試、缺／多／重複／錯版 rows 拒絕、同目標並行只一筆 history，以及 setup 後新增未知工作導致 finalizer 拒絕時 extension／DB pool／owned logger 清理且無 registry／history。
- 全單元 54 files／599 PASS：`/tmp/storeweave-b02-registry-full-unit.log`；typecheck PASS：`/tmp/storeweave-b02-registry-final-typecheck.log`；git diff --check PASS。Sol/high `activationreviewb02` 正 scoped 複核，尚未視為整個 B02 審查通過。
- 後續升級設計來源：`/tmp/storeweave-b02-atomic-and-archive-design.txt`。使用唯一 incoming staging、系統 tar 安全預設、拒絕不需要的 links／特殊節點與非法路徑，共用 native／CLI candidate validator，再依 validated metadata 推導 final directory；snapshot／external-writer precondition 與真正 snapshot rollback 仍待實作。

### Candidate 驗證與原子安裝（2026-09-08，審查修正中）

- CLI upgrade 先複製 archive 到唯一私有 incoming，再以系統 tar 列出路徑／header mode，拒絕絕對路徑、父目錄、links、特殊節點、setuid/setgid 與 control characters；解壓明確停用來源 ownership、permissions、ACL 與 xattrs。解壓後 lstat 重驗整棵樹，再核對 RELEASE／VERSION／build manifest checksum、必要四程序與 native 檔案，依內容推導 final version，不依 archive 檔名。
- `release-validation.ts` 為 native installer 與 CLI 共用邊界，獨立 helper 隨 build 打包，仍保留四個應用 entry。Native installer 改用私有 staging 複製並驗證 staged tree，再 exclusive mkdir＋rename；不再直接 cp 到 final directory。複製失敗只清理自身 staging；rename 失敗保留空 reservation，避免誤刪被併發程序換掉的目錄。這是結構／一致性驗證，並非 publisher authenticity 驗證。
- Sol/high review `/tmp/storeweave-b02-candidate-sol-review.txt` 指出 native copy 非原子、root tar metadata、reservation cleanup ownership 與 archive 資源上限。前三項已修正；最後一項仍在收斂可攜上限，不能宣稱安全審查已通過。Snapshot／external writers／真正 rollback 仍未完成。
- 聚焦 archive／native copy／upgrade 30 PASS：`/tmp/storeweave-b02-candidate-review-fixes-r4.log`，涵蓋完整合法 fixture 加 hostile entries、root 名稱／root link／device、既有 final directory/file/dangling link 保存、copy 中斷／staged metadata 改動／併發 target 與 reservation 換掉後失敗。GNU tar reader/extractor 27 PASS：`/tmp/storeweave-b02-candidate-gnu-tar-r4.log`（早於最後新增 reservation test）；隔離 Docker 只掛載測試暫存根目錄。
- GNU parity 初次使用容器打包 fixture 出現 file-changed 診斷；改用本機封裝後發現 macOS Apple metadata 多一個根節點。測試封裝已對齊正式 build 的 COPYFILE_DISABLE／no-xattrs，再跑通過；未放寬 production root 檢查。
- 本片段較早完整單元 55 files／615 PASS：`/tmp/storeweave-b02-candidate-full-unit.log`；最後 copy 修正後聚焦結果以上述 30 項為準。Typecheck PASS：`/tmp/storeweave-b02-candidate-review-typecheck-r2.log`（之後僅新增 reservation test）。Base／Commerce 四程序產物與 validator forbidden-import assertion 2 PASS：`/tmp/storeweave-b02-candidate-artifacts-r2.log`（早於 native copy 修正，最終仍須重建）。
- Copy／reservation 修正後完整單元 55 files／627 PASS：`/tmp/storeweave-b02-candidate-copy-full-unit.log`；typecheck PASS：`/tmp/storeweave-b02-candidate-copy-typecheck.log`；Bash 5 syntax 與 git diff --check PASS。原有 release 2,461 個檔案 SHA-256 全部保持不變。
- 新版 Base 0.1.4-test 原生安裝／tamper 拒絕／重裝拒絕／非 root 執行／10 項 HTTP／真正停止 PASS：`/tmp/storeweave-b02-candidate-native-smoke-r4.log`。先前 r3 HTTP 通過但 stop 逾時；最小容器重現證明缺 init 時已退出 child 留為 zombie，kill(pid,0) 仍成功，--init 則回收。Smoke 容器加 --init 對齊 native host；沒有放寬 production stop/drain。Commerce 正重跑，.deb 尚未測試。
- Commerce 0.1.4-test 原生安裝與 61 項 HTTP、PID-mode stop PASS：`/tmp/storeweave-b02-candidate-commerce-native-smoke.log`。Base／Commerce 最終新產物分別位於 `/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-native-smoke.oq4isz/release`、`/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-native-smoke.BPnV9K/release`；本次兩個 smoke 自有容器與 network 均由腳本清理。

### Archive 資源邊界與復原狀態輸出（2026-09-08）

- Sol/high 固定上限設計：`/tmp/storeweave-b02-archive-limits-design.txt`。現有 Base／Commerce 產物約 49／63 MiB、展開153／176 MiB、3,040／3,054項；因此採256 MiB compressed、1 GiB logical payload、10,000 members、1,024 UTF-8 pathname bytes。沒有新增 dependency／tar parser／可配置上限。
- Source與private copy檢查compressed size；tar --numeric-owner verbose前綴只接受GNU uid/gid或bsdtar links/uid/gid格式，以BigInt加總，listing數量必須吻合。Unknown格式、超限與mode/type失敗在解壓前拒絕。List/inspect60秒、extract300秒，SIGKILL timeout；directory walk亦檢查logical bytes／members／path，native copy前後同規則。
- Archive／upgrade聚焦38 PASS：`/tmp/storeweave-b02-archive-limits-unit-r2.log`；GNU讀取／解壓36 PASS：`/tmp/storeweave-b02-archive-limits-gnu.log`。包含oversized sparse archive、native sparse payload、10,001項／過長path、未知numeric header／count mismatch／BigInt大數拒絕與timeout options。
- 新Base／Commerce0.1.4-test真tarball各由最新validator配合bsdtar／GNU成功promotion，共4次：`/tmp/storeweave-b02-archive-real-parity.log`；測試根目錄pointer `/tmp/storeweave-b02-archive-parity-path`。產物內helper早於本次上限，測的是最新validator安裝完整真產物；最終release仍須重建。
- 真Linux root／GNU integration PASS：`/tmp/storeweave-b02-archive-root-limits.log`。含numeric uid/gid33333/44444、0777與PAX ACL/xattr的檔案被還原為root:root0755且無xattrs；1 GiB+1 sparse archive在解壓前拒絕，既有release不變。測試bundle直接編譯production validator，不以fake validator取代。
- CLI新增 `migrate --status --json`，未帶--status時拒絕--json。真PG2 PASS：`/tmp/storeweave-b02-status-json.log`；cold status沒有domain table／effective row／extension setup，migrate後status為current且不重複append。供snapshot復原核對，尚未實作paired rollback。
- 全單元55 files／635 PASS：`/tmp/storeweave-b02-archive-limits-full-unit.log`；typecheck PASS：`/tmp/storeweave-b02-archive-limits-final-typecheck.log`。Sol/high同一pane正收斂snapshot／exact-schema restore與DB identity binding，B02仍active。
- 真程序 migrationless gate 連同四程序產物3 PASS：`/tmp/storeweave-b02-migrationless-artifact-gates.log`。Base0.2.0啟用後以0.2.1（相同SQL）檢查pending=[]但releaseCurrent=false；API／worker／extension:list明確拒絕，doctor輸出乾淨JSON fail，history仍一筆。顯式migrate後current=true、history兩筆，原SQL ledger逐欄不變。Typecheck：`/tmp/storeweave-b02-migrationless-typecheck.log`。
- 還原前置實驗（僅新建disposable PostgreSQL17）：`/tmp/storeweave-b02-restore-transaction-probe-r2.cjs`／`.log`。pg_restore先輸出SQL，再以psql --single-transaction＋ON_ERROR_STOP執行DROP/CREATE public與restore script；注入錯誤時原兩張表與資料完整回滾，成功時新增表消失且舊資料復原。第一輪 `/tmp/storeweave-b02-restore-transaction-probe.log` 證實dump不自動CREATE預設public，缺schema導致還原拒絕。這只驗證交易與資料／物件行為，不是完整owner／ACL／跨schema安全契約；Sol設計尚在收斂，production snapshot/rollback未接入。

### 一致的來源 snapshot 入口（2026-09-08，CLI 接線待完成）

- 新增 DB `withReleaseSnapshot`，kernel只傳遞自己的純release selection／migration sets。取得既有migration session lock後，以REPEATABLE READ READ ONLY核對current、完整source migrations、保存資料關聯，再export snapshot給dump callback；callback結束前transaction與lock保持開啟。這不是writer fencing，外部writers停止仍是正式upgrade前置條件。
- 同一snapshot記錄DB name/OID/cluster system identifier/server version、最新effective release與完整migration/release-history rows摘要。以PostgreSQL JSON保留timestamp微秒，history bigint sequence轉字串，避免Node Date／JSON數字精度丟失。無raw URL或password進入此型別。
- 初次測試揭露既有readHistory暗中執行ensureHistory DDL，與read-only transaction衝突。已使readHistory純讀；ensureHistory留在status／migration／transition的明確寫入入口，逐一核對全部caller。既有migration-lock5／migration-history17／release-transition29共51 PASS：`/tmp/storeweave-b02-release-snapshot-r2.log`（該次新增snapshot tests兩項fixture問題另行修正）。
- Snapshot真PG3 PASS：`/tmp/storeweave-b02-release-snapshot-r4.log`。在export後故意新增probe資料／改ledger時間1微秒，真pg_dump --snapshot及scratch pg_restore仍匹配原data／完整ledger指紋；下一snapshot可辨識微秒變化。亦涵蓋bigint9007199254740993、migrationless非current與missing source migration在dump前拒絕、dump failure釋放lock並可重試、明確REVOKE pg_control_system權限後fail-closed。PG17預設可由測試reader呼叫該函式，不能宣稱預設一定需superuser。
- 全單元55／635 PASS：`/tmp/storeweave-b02-snapshot-source-unit.log`；typecheck PASS：`/tmp/storeweave-b02-snapshot-source-final-typecheck.log`；git diff --check PASS。Sol/high activationreviewb02正獨立審查此DB/kernel切片。
- Scratch設計修訂 `/tmp/storeweave-b02-snapshot-design-r2.txt`：完整dump保留owners／ACL，先restore到template0新DB並核對，再以maintenance transaction原子rename live→quarantine、scratch→live，保留quarantine。主代理真PG17證據 `/tmp/storeweave-b02-database-rename-probe.log` 證明兩次rename可在同一transaction，第二次失敗全部回滾，修正初版Sol「rename非原子」說法。
- 修訂設計第9點曾漂移為migration failure自動DB rollback；主代理已明確拒絕該漂移：失敗保留snapshot/current、服務保持停止，不自動restore；只有明確paired rollback --yes及fresh external-writer acknowledgement可還原。OID/name mapping用於辨識COMMIT後journal/symlink尚未寫完的狀態，不能僅信phase。
- 下一切片仍需snapshot檔案／私有PGPASSFILE、DB metadata與maintenance credential、local transition lock、scratch restore與OID重試、CLI upgrade/rollback整合及installer既有current拒絕。另須明確驗證B01舊artifact缺新manifest/status能力的升級與復原操作路徑，不能以新B02→B02流程替代舊binary驗收。
- Sol source-snapshot review `/tmp/storeweave-b02-snapshot-source-review.txt`：交易／cleanup正確，但缺history identity generator state。已新增historySequence.lastValue字串／isCalled，測試把generator設到超過max(row)且尚未consume，真dump/restore後核對generator與下一筆INSERT sequence。另固定DateStyle ISO,YMD，鎖釋放測試改用不同backend PID的獨立Client。
- Sequence非MVCC，callback前後再次核對generator，非預期advance拒絕helper成功，避免發布不一致snapshot。Callback只可stage，須等helper commit/unlock成功後才能publish。聚焦3 PASS：`/tmp/storeweave-b02-release-snapshot-sequence-guard.log`；typecheck PASS：`/tmp/storeweave-b02-snapshot-sequence-typecheck.log`。最後僅加metadata shallow copy及API註解，Sol正複核。

### Native PG 憑證與備份發布（2026-09-08）

- `pg-tool.ts` 由CLI backup／restore共用：連線密碼改放0700暫存目錄內0600 PGPASSFILE，移除URI password；PGPASSWORD只作輸入，不傳給child，其他application secrets不在allowlisted child env。保留SSL等必要PG設定，URI query值重新percent-encode，避免空白變成libpq不認得的form-style加號。無密碼時可用既有private passfile的私有副本；所有出口清理暫存credentials。
- Sol review `/tmp/storeweave-b02-pg-tool-review.txt` 的三項已修正：拒絕URI host/hostaddr/port/user/dbname等連線覆寫與connection CLI switches（含縮寫／短選項）；既有passfile須regular、無group/other權限、<=1MiB；明確空密碼不得fallback其他憑證。URL authority無userinfo但含port不誤判為空密碼。
- `writePgBackup` 預建0600私有staging dump，完整pg_dump保留owners／ACL，pg_restore --list成功後fsync並以同filesystem exclusive link發布；目的地已存在或併發建立均保留它，失敗只清理自己的staging。Raw CLI backup已接上，不再等成功後才chmod。Raw restore暫時保留原本--clean/--no-owner語意；它不是完整版本rollback。
- 聚焦34 PASS：`/tmp/storeweave-b02-backup-cli-unit.log`，含permission/FIFO/oversized passfile、connection override、credential cleanup、partial dump/list failure、併發destination保存，以及真的CLI child使用不可連線DB配置仍可由fake native tools完成backup，證明沒有runtime activation。Fake工具僅用於單元orchestration，實際PG另測。
- 真PG17備份／還原PASS：`/tmp/storeweave-b02-backup-publication-integration.log`。使用colon/backslash密碼透過實際pg_dump/pg_restore認證；完整custom dump還原非public schema、table/schema owner、USAGE/SELECT與exact default ACL grantee/grantor/privilege。每次native client只掛載該次password目錄及test tree，無hostDB操作。
- 全單元56 files／668 PASS：`/tmp/storeweave-b02-backup-publication-full-unit.log`（之後新增上述CLI child一項，聚焦34 PASS）；typecheck PASS：`/tmp/storeweave-b02-backup-publication-typecheck.log`；diffcheckPASS。Sol/high正在scoped複核pg-tool與backup發布，尚未宣稱整個snapshot/rollback完成。
- Source snapshot額外捕捉同一RR snapshot的DB owner/encoding/locale provider/locale/ICU rules/collate/ctype/tablespace/connection limit/comment/database ACL與per-database/per-role settings，供scratch重建。真PG3 PASS：`/tmp/storeweave-b02-snapshot-database-properties.log`，核對自訂DB CONNECT grant、DB search_path、role statement_timeout、connection limit及comment；typecheck `/tmp/storeweave-b02-snapshot-properties-typecheck.log` PASS。這些metadata尚未接入scratch還原。
- Legacy bridge scoped設計 `/tmp/storeweave-b02-legacy-bridge-design.txt`：從驗證B02媒體直接執行，明確--from-legacy-b01/catalog/evidence，不能自動fallback損壞modern artifact。保存完整B01 recovery tree digest；baseline DDL前raw safety snapshot，採納後再paired snapshot並保留兩個false flags。只允許相同candidate向前retry或透過B02 explicit paired rollback還原並啟動真正B01。這是待實作／真binary驗證的操作路徑，不能以B02→B02取代。

### 備份安全複核修正（2026-09-08 02:30）

- Sol複核確認exclusive hard-link publication正確，指出query password原始加號、offline list不需憑證、passfile path race及pg_restore preflight。已修正：原始+拒絕並要求%2B（%20亦測）、離線list只收非PG allowlist環境、O_NOFOLLOW/O_NONBLOCK一次open後同fd fstat與1MiB+1限量read；CLI在dump前檢查兩個工具。
- 聚焦39 PASS `/tmp/storeweave-b02-pg-review-fixes-unit.log`，涵蓋symlink/FIFO拒絕、offline argv/env無DB參數、真正CLI child缺pg_restore時不執行pg_dump。真PG17 1 PASS `/tmp/storeweave-b02-pg-review-fixes-integration.log`，保留owner/default ACL且published dump mode0600。typecheck PASS `/tmp/storeweave-b02-pg-review-fixes-typecheck.log`，diffcheck PASS。無新增依賴。
- Sol/high原pane activationreviewb02 wA:p1Y已派scoped re-review，輸出預定 `/tmp/storeweave-b02-pg-tool-r3-review.txt`；尚在working，請consume，勿因等待重啟。B02仍未完成；下步仍immutable paired snapshot與完整tree fingerprint/journal/lock、scratch+OID切換、explicit B01橋接及fresh-only installers。既有blind rollback尚未替換，不能宣稱安全版本回退完成。此輪實質修正，無外部blocker。

### 完整 artifact 指紋與配對快照封裝（2026-09-08 02:34）

- 上輪pg-tool scoped Sol PASS已收取：`/tmp/storeweave-b02-pg-tool-r3-review.txt`，四項修正與39 unit/realPG/typecheck證據通過；不涵蓋transition。
- `tools/cli/src/release-validation.ts` 現在於既有bounded walk計算treeChecksum，包含所有相對路徑／entry type／mode／file size＋SHA256，排序後catalogDigest；排除uid/mtime以維持copy一致性。File以O_NOFOLLOW/O_NONBLOCK同fd讀取，限於已驗證size，讀後mtime/ctime變動拒絕。這不是publisher signature或對抗有權改寫整棵tree的writer fencing。
- 新CLI私有 `tools/cli/src/release-snapshot.ts` createPairedSnapshot：驗證source/candidate完整artifact，要求explicit DB host；接受現有withReleaseSnapshot callback boundary。callback內比對DB source release/version/build checksum，writePgBackup使用exported snapshot，stream SHA256 dump、再檢查兩棵tree未變，寫0600 descriptor並fsync。outer capture（DB commit＋unlock）resolve後才exclusive mkdir reservation＋rename整個private bundle並sync parent；失敗只清理ownstaging，finalreservation不亂刪。
- Descriptor包含schemaVersion/id/time/source/candidate tree與manifest指紋、endpoint host/port/DB-name digest、完整DB source evidence（含properties/historySequence），dump檔名/bytes/SHA。Raw connection URL／密碼／暫時snapshotId不持久化。回傳descriptor catalogDigest供未來journal綁定。尚未接CLI upgrade/rollback，未建立lock/journal或scratchrestore，不宣稱已具備完整回退。
- 聚焦3 files／44 PASS `/tmp/storeweave-b02-paired-snapshot-unit.log`：37 release validation＋2 CLI upgrade＋5 snapshot，含copy/mtime穩定、額外asset內容/mode/rename/emptydir改變指紋，commit failure/source mismatch/artifact change不publish、私有檔權限及無明文憑證、implicit host拒絕。Snapshot單元使用fake dump/capture；尚需真PG與真正source artifact串接驗證。
- Typecheck PASS `/tmp/storeweave-b02-paired-snapshot-typecheck.log`，diffcheck PASS。現有真Base/Commerce native0.1.4-test artifacts read-only完整tree驗證PASS `/tmp/storeweave-b02-real-tree-fingerprints.log`；未重建或改rootrelease。
- 原Sol/high pane activationreviewb02 wA:p1Y liveworking新scoped review，預定 `/tmp/storeweave-b02-paired-snapshot-review.txt`，最後確認約1m。請接續consume，勿timeout重啟。下一步接真PG配對snapshot驗證、operationlock/journal、scratch DB metadata restoration＋OID切換，CLI wiring與explicitB01bridge/fresh-onlyinstallers仍全數必要。此輪有實質進展，無外部blocker。

### 配對快照真 PG 驗證與端點固定（2026-09-08 02:38）

- `tests/integration/pg-tool.test.ts` 改用真正Base runtime migrate/withReleaseSnapshot→createPairedSnapshot→native pg_dump/pg_restore，還原後比對完整history checksum、migration checksum與history identity sequence，沿用nonpublic schema/table owner/ACL/default ACL及dump0600檢查。Artifact tree是結構fixture，但載入真正buildReleaseManifest；不宣稱已測native binary rollback。
- 最新真PG17 1 PASS `/tmp/storeweave-b02-paired-real-pg-r2.log`（初版 `/tmp/storeweave-b02-paired-real-pg.log`）。只操作owned Testcontainers與private Docker client mounts，已清理runtime/container/testtree。
- `createPairedSnapshot` 現在要求explicit host和DB path，decoded DB name必須等於capture evidence；port採URI/PGPORT/default5432解析並固定寫入native dump URI與endpoint fingerprint，避免記錄5432但實際連到繼承PGPORT。新增wrongDB及PGPORT regression，snapshot聚焦7 PASS `/tmp/storeweave-b02-paired-endpoint-unit.log`；typecheck PASS `/tmp/storeweave-b02-paired-endpoint-typecheck.log`；diffcheckPASS。
- Sol/high activationreviewb02 wA:p1Y依然liveworking（最後5m08s），scoped report預定 `/tmp/storeweave-b02-paired-snapshot-review.txt`。已提示早期4case/source觀察過時，請其讀目前7case/source與真PG結果；新訊息等待它下一tool boundary。不要重啟。上一輪和本輪皆實质progress，無外部blocker。
- 下一步仍consume findings→操作lock/journal與scratch完整restore/DBproperties/OID原子切換→CLI升級與paired rollback接線→explicitB01橋接、fresh-onlyinstallers及完整驗收。現在只完成snapshot creation封裝與真PG證據，尚無snapshot reader/restore/journal，不可把完整B02判DONE。

### 還原前快照讀取邊界（2026-09-08 02:41）

- 新 `tools/cli/src/read-release-snapshot.ts` readPairedSnapshot(directory, expectedChecksum)：expectedChecksum須來自選定transition journal，不能自信snapshot自帶hash。先private root與O_NOFOLLOW/O_NONBLOCK regular single-link 0600檔限制，metadata同fd限量讀最多1MiB，catalogDigest matching後Zod strict schema，驗證UUID dirname、source/candidate/effective identity，再重驗兩棵完整artifact指紋。Dump同fd stream hash/size/mtime/ctime驗證，回傳已驗證descriptor與dump path。是還原前驗證，使用時仍須private owned storage/transition lock，並在restore前重新驗證；不是對抗root writer fencing。
- Schema限制format version、absolute artifact path、固定database.dump、digest shape、DB properties/ACL/settings/history sequence完整shape。無新增依賴（沿用zod）。不做DB或外部sideeffects。
- 聚焦13 PASS `/tmp/storeweave-b02-snapshot-reader-unit.log`，涵蓋journal checksum mismatch、同長度dump竄改、權限、sourceartifact更改、matchingdigest但invalidschema/relativepath/traversaldump、symlink與oversizedmetadata拒絕。
- 真PG17 create→read/verify→pg_restore→exacthistory/migration/generator＋owners/ACL/defaultACL 1 PASS `/tmp/storeweave-b02-snapshot-reader-real-pg.log`；structural artifact帶realbuildmanifest，仍非nativebinaryrollback證據。typecheck `/tmp/storeweave-b02-snapshot-reader-typecheck.log`，diffcheckPASS。
- Sol/high activationreviewb02 wA:p1Y仍working prior create/tree scopedreview（最後8m04s），輸出預定 `/tmp/storeweave-b02-paired-snapshot-review.txt`。已請其限定scope完成；本輪新reader明確排除在該review外，之後需獨立scoped review。不要重啟。完整B02未完成，journal/lock/scratchrestore/CLI/legacybridge/fresh-onlyinstaller皆仍必要。此輪有實質progress，無blocker。

### 快照穩定性修正與 native 首次安裝限制（2026-09-08 02:45）

- 已收取Sol initial `/tmp/storeweave-b02-paired-snapshot-review.txt`：兩項artifact stability findings，均修正。createPairedSnapshot在capture完整resolve（含COMMIT/unlock）後再次驗證兩棵tree才reserve/publish；validator記錄每個directory dev/ino/mode/mtime/ctime＋sorted childnames，完成walk/metadata讀取後recheck。仍不宣稱對抗有權任意改root的writer fencing。
- Exactregressions：after dump callback後source/candidate mutation各拒絕無publish，首次readdir後add/remove/swap各拒絕。3files57 PASS `/tmp/storeweave-b02-snapshot-stability-unit.log`；realPG create/read/restore PASS `/tmp/storeweave-b02-snapshot-stability-real-pg.log`。Typecheck最初ReturnType lstat含undefined，已改explicit Stats，最終PASS `/tmp/storeweave-b02-snapshot-stability-typecheck.log`。
- `scripts/install-native.sh` fresh-only：earlyguard拒絕任何existing current含danglinglink，移除previous/switch覆寫邏輯，最終ln -sT exclusive establish current，併發existing也不覆寫。尚未加shared transition lock（必要next）；.deb guard/config parity仍待實作，未宣稱兩installer完成。
- 新 `tests/integration/native-install-guard.test.ts` 真installer＋bundledvalidator在owned node22 root容器，structural appfixture（非productionbinarysmoke），freshinstall成功/env0640/current正確；四種existing current（link/dangling/file/dir）皆拒絕且inode保留、candidate未安裝。1PASS `/tmp/storeweave-b02-native-install-guard.log`；typecheck `/tmp/storeweave-b02-native-install-guard-typecheck.log`；diffcheckPASS。docsdeploymentnative更新fresh-only與correct0640root:commerce。
- Sol/high原pane activationreviewb02 wA:p1Y working新scopedreview stabilityfixes＋reader，預定 `/tmp/storeweave-b02-snapshot-reader-sol-review.txt`，最後確認2m34s。consume結果，不重啟；未把新nativeguard納入本次scope。此輪實質progress無blocker。
- 下一完整scope仍operationlock/journal、scratchDB fullrestore+properties+OIDcutover、CLIupgrade/pairedrollback、explicitB01bridge與.deb/finalsmokes；B02未完成，B03–B17不可漏。

### OID 原子切換邊界與最後檔案穩定性修正（2026-09-08 02:50）

- Sol reader審查 `/tmp/storeweave-b02-snapshot-reader-sol-review.txt`：前兩項已PASS，reader本身PASS；另指出已hash檔案在postwalk metadata讀取期間被in-place修改不影響directory metadata。已保留files stat/path，final re-lstat dev/ino/nlink/mode/size/mtime/ctime；exactfirstmetadataread修改app/api.js regression拒絕。聚焦3files58 PASS `/tmp/storeweave-b02-file-stability-unit.log`。
- 新 `tools/cli/src/database-cutover.ts` cutOverOrRecognize(Client,intent)：strict intent/name/OID schema、distinctnames/OIDs，maintenance DB必須不在三個names中且cluster systemIdentifier匹配；BEGIN後LOCK TABLE pg_database SHARE ROW EXCLUSIVE，再讀actualOIDmapping。已committed map返回already-committed；未committed需exactliveold/scratchnew/noquarantine且無live/scratch sessions，兩次ALTER DATABASE RENAME同tx，失敗ROLLBACK/Aggregatecleanup。Quarantine永不DROP。Caller明確必須先fsyncintentjournal且verifyrestoredsnapshot；helper本身不提供這兩項，尚未CLI接線。
- Sharedcatalog lock為避免OIDcheck與rename之間其他DDL改名；真PG17 superuser maintenance測試可行。這是raretransition全clusterDB-DDL鎖，已ponytail註明，尚待Sol確認權限／鎖語意與operationalbounds，未宣稱一般CREATEDBrole足夠。
- 新真PG17 integration `tests/integration/database-cutover.test.ts` 1PASS `/tmp/storeweave-b02-database-cutover.log`：wrongcluster/OID與activeconnection拒絕；query interception只在secondrename改成真PGmissingdatabaseerror，驗證第一次rename也完整回滾；再正常cutover／重跑recognizedcommitted，精確OIDmap與quarantine保留。無realprocesscrash測試，recognitionpath有覆蓋但不要稱actualcrashsmoke。
- Typecheck PASS `/tmp/storeweave-b02-cutover-typecheck.log`，diffcheckPASS。舊PGsnapshotreader/ownersACL測試沒有再重跑（本輪新DBcutover獨立，filefix由58unit覆蓋）。
- Sol/high activationreviewb02 wA:p1Y新任務scoped analysis/review finalfilefix＋databasecutover，預定 `/tmp/storeweave-b02-cutover-sol-review.txt`，剛prompted需下一輪get/read確認live。現有helper是主代理高風險實作；無subagentwriter。此輪實质progress，無blocker。
- 下一完整scope仍consume findings→journal/localtransitionlock＋scratchrestore完整DBproperties/ACL/settings→CLIupgrade/pairedrollback→explicitB01bridge/.deb/finalsmokes；不能止於atomicrenamehelper或縮小B02/fullB03–B17。

### Scratch full dump 與 DB metadata 還原（2026-09-08 02:56）

- 新 `tools/cli/src/restore-release-snapshot.ts` restoreSnapshotToScratch：先readPairedSnapshot，maintenance endpoint hash／cluster systemIdentifier匹配；產生unique storeweave_restore_UUID DB，用template0/sourceowner/encoding/libc或ICU或builtin locale/ICUrules/collate/ctype/tablespace建立，再runPgTool pg_restore --exit-on-error --single-transaction，不帶clean/no-owner/no-privileges。
- 另用metadata tx恢復DBcomment/connectionLimit，清除新DB預設PUBLIC/ownerACL，再按has_database_privilege(...WITH GRANT OPTION)可用順序SET LOCAL ROLE grantor重建ACLchain；RESET ROLE回admin。DB/per-role settings以set_config(parameter,value,true)+ALTER DATABASE或ALTER ROLE IN DATABASE SET ...FROM CURRENT保留list類型語意。COMMIT前重讀exactACL(grantor/grantee/privilege/grantable)與settings比對。無自動DROP或live切換。
- 真PG17完整createpair→reader→scratchhelper→data/history/migrations/sequence/owners/defaultACL驗證PASS `/tmp/storeweave-b02-scratch-restore-metadata.log`；新增非owner grantor→leaf的CONNECT授權鏈（含grantoption）、DBsearch_path retained,public、role statement_timeout42s、comment與connectionlimit42。源DB與runtime仍保持active；測試僅ownedcontainer，完成cleanup。
- Typecheck PASS `/tmp/storeweave-b02-scratch-typecheck.log`，diffcheckPASS；無新增依賴，SQLidentifier/literal使用既有pg escapeIdentifier/escapeLiteral。
- 參考官方PG17 CREATE DATABASE https://www.postgresql.org/docs/17/sql-createdatabase.html （template0不複製DBconfig/permissions）、ALTER DATABASE https://www.postgresql.org/docs/17/sql-alterdatabase.html （SET FROM CURRENT）、GRANT https://www.postgresql.org/docs/17/sql-grant.html （SET ROLE控制grantor）。未宣稱所有locale/profile matrix均驗證；本輪真PG使用libc。
- 尚需在fullorchestrator之前補：scratch name/createdOID的durablejournal時序（目前name內部生成、只成功後回傳，失敗scratch保留但caller尚無durabletracking）；scratch驗證source runtime與DBproperties完整identity；restrictiveGUC設定套用時session副作用需要審查；failure/missingroles/locale等negative cases；不得以helper成功替代完整restore/rollback驗收。
- Sol/high activationreviewb02 wA:p1Y仍liveworking上輪cutover locking/recovery+finalfilestatfixreview（最後6m16s，正在PGofficial/source研究），預定 `/tmp/storeweave-b02-cutover-sol-review.txt`。本輪scratchhelper尚未交review，consume前任務再交此scope，不要重啟。此輪有實質progress，無外部blocker。全B02及B03–B17目標保持。

### Scratch journal 與 cutover 權限／交易修正（2026-09-08 03:04）

- `restoreSnapshotToScratch` 新required journalDirectory參數；readpair後建立privateUUIDjournalhome，planned JSON含schemaVersion/kind/id/phase/snapshotdir+checksum/cluster/liveoriginalOID/scratchname+nullableOID/quarantinename，wx0600→fsync→rename→syncdir/parent。planned在DBcreate之前；取得createdOID後先persistcreated才runpg_restore；成功restored、失敗failed留DB與journal（不記原始error/URL/password）。新增live sourceOID檢查。回傳journalFile。
- 真PGjournal/order PASS `/tmp/storeweave-b02-scratch-journal-order.log`：native client wrapper在每次realrestore前確認相應journal已是created且有OID（不只驗證最後檔案）；成功restored0600；failure注入nativeclientexit2後failed保有scratchOID，DB仍存在且sourceOID未變。Typecheck PASS `/tmp/storeweave-b02-journal-order-typecheck.log`，diffcheckPASS。
- Journal仍缺strict reader/resume與localoperationlock/cutoverphase更新。CREATE DATABASE成功到OID寫入之間crash仍可能只有planned且DB已存在；未證實來源的DB不能自動drop/reuse，後續resume需failclosed或新attempt保留原物件。currenthelper未CLI接線，不宣稱完整recovery。
- 已收取 `/tmp/storeweave-b02-cutover-sol-review.txt`：finalfilefixPASS；cutover search_pathspoof(HIGH)、ambienttx(MEDIUM)、sessionguard非fencing/lockbound(MEDIUM)。已改helper自建freshClient(maintenanceUrlstring)，schema-qualified全部pg_catalogfunction/relation/type，SETLOCALsearch_pathpg_catalog/lock_timeout5s；保持hardexternalwriters/drainprereq與elevatedcatalogprivilege，無內部retry。
- 真PG cutover修正1PASS `/tmp/storeweave-b02-cutover-guard-r3.log`（15.5s）：trap.pg_database錯OID不可信、callerambienttabletx未被commit、limitedCREATEDBrole denied、另一session持真catalogRowExclusiveLock觸發5sboundedtimeout、activitycheck後才進live的connection拒絕並rollback、原secondrenameerrorrollback、normalcommit與recognizedretry。Typecheck `/tmp/storeweave-b02-cutover-guard-typecheck.log` PASS。PG本身拒絕latebackend並非我們提供producerfencing；短暫writer違反operatorcontract。
- Sol/high activationreviewb02 wA:p1Y已confirmedworking新review（預定 `/tmp/storeweave-b02-scratch-journal-sol-review.txt`）：cutoverfixes＋restore/journal。特別請分析set_config(...true)+FROMCURRENT的restrictiveGUC/role/search_path副作用與newrestorehelper catalogname spoofing，最小完整修法，不許省略source settings。這些是已知需解決的邊界，下一輪consume/實作；未把目前helper當productionready。
- 下一完整scope仍reader/resume/localmutex、metadata副作用與完整scratch runtimeverify、CLIupgrade/rollback/explicitB01bridge/.deb/fullsmokes。此輪真實progress，無外部blocker；B02/fullB03–B17保持active。

### GUC 還原副作用修正（2026-09-08 03:10）

- `restore-release-snapshot.ts` 不再對所有source settings執行set_config。普通GUC直接ALTER DATABASE/ROLE IN DATABASE SET key TO quotedliteral；PG17七個GUC_LIST_QUOTE按PostgreSQL native dump方式解析quotedlist並逐項literal，避免transaction_read_only/statement_timeout等影響維護session。來源是官方PG17 dumputils.c variable_is_guc_list_quote/makeAlterConfigCommand https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/dumputils.c 及SplitGUCList https://github.com/postgres/postgres/blob/REL_17_STABLE/src/fe_utils/string_utils.c 。未新增依賴，沿用pg escapeLiteral。
- Source metadata SQL已完整限定pg_catalog function/relation/type，connect後先SETsearch_pathpg_catalog。沒有再依賴source/maintenance自訂search_path查證DBidentity/ACL/settings。
- 真PG regression包括role transaction_read_only=on、statement_timeout1ms、自訂GUC帶apostrophe/逗號、search_path項目內含comma/doublequote/SQL-looking文字，仍exactsettingsreadback且完成dump/data/history/sequence/owners/ACL/journal。初版direct路徑PASS `/tmp/storeweave-b02-scratch-guc-direct.log`。
- 加rawempty temp_tablespaces FROMCURRENT case後確實red `/tmp/storeweave-b02-scratch-guc-empty.log`：SQL TO empty literal會變成單一emptyitem，與rawemptylist儲存值不同。現僅對knownlist且全ASCIIwhitespace/empty的值savecurrent→localsetrawempty→ALTER FROMCURRENT→restoreprevious；非空值不改session。Exactemptycase與上述全部真PG PASS `/tmp/storeweave-b02-scratch-guc-complete.log`。此例外仍需Sol確認對各knownlist上下文安全，沒有掩蓋或丟棄source值。
- Typecheck PASS `/tmp/storeweave-b02-scratch-guc-typecheck.log`，diffcheckPASS。Source/destinationmajor-version相容範圍與native-listvariable清單版本化尚待review，未先擅自把fulltask收窄到只接受PG17。
- Sol/high activationreviewb02 wA:p1Y仍liveworking scratch/journal＋cutoverfixreview（最後6m15s），預定 `/tmp/storeweave-b02-scratch-journal-sol-review.txt`。已多次送目前code/evidence與nativePG來源；原all-settings-set_config分析若過時需對目前code核對。後續consume findings，勿重啟。此輪實質progress無blocker。
- 全scope仍reader/resume/localtransitionlock、scratchruntime/完整metadata驗證、CLIupgrade/pairedrollback/explicitB01bridge/.deb/finalchecks；B02/fullB03–B17均未complete。

### Native／CLI 共用 kernel 操作鎖（2026-09-08 03:19）

- 新 `tools/cli/src/transition-lock.ts` withTransitionLock(home,action)：Linux flock --no-fork/--exclusive/--nonblock/exit75，固定Node holder只等stdin EOF；只給PATH環境，不帶applicationsecrets。holder確認locked後才callback，finally關stdin等exit；根程序死後pipe EOF使singleholder退出kernel放鎖，無自訂PID stale-reclaim。鎖檔persistent，永不unlink，避免不同inode雙鎖。
- `scripts/install-native.sh` 建立PREFIX後execfd9<>.transition.lock並flock -n9，與helper相同inode；既有fresh-onlyguard與finalexclusive ln-sT保持。`main.ts` upgrade與rollback兩個action整段包helper，候選staging/manageddrain/migrate/symlinks均在同lock內。原blindrollback本體仍待pairedrestore替換，不能宣稱版本回滾安全完成；.deb尚未共用此lock。
- Linux實測 `tests/integration/native-install-guard.test.ts` realflock＋realinstaller／validator（structuralapplicationfixture）：nestedCLI拒絕、持CLI鎖時installer拒絕且無current、callbackthrow後freshinstall成功；新增realchild持鎖後SIGKILL，重新取得同inode成功。1PASS `/tmp/storeweave-b02-transition-lock-crash.log`；ownedNode22containercleanup完成。
- CLI既有orchestration unit2PASS `/tmp/storeweave-b02-cli-transition-lock-unit.log`。Host macOS沒有flock；單元fixture以passthrough native command shim只驗證CLI接線/manageddrain，真lock語意由上述Linuxintegration證明，不把shim當locking測試。Typecheck PASS `/tmp/storeweave-b02-cli-transition-lock-typecheck.log`，diffcheckPASS。docsdeploymentnative補Linuxflock prerequisite與persistentlockfile。
- Lockhelper尚需Sol獨立review，特別holder unexpectedexit/action進行中、FSownership與CLIprocess.exit路徑（目前實測parentSIGKILL釋放）等邊界；不得把kernel鎖稱externalproducerfencing。
- Sol/high activationreviewb02 wA:p1Y仍confirmedworking scratch/GUC/journal＋cutoverfixreview（最後12m10s，之後已請限定scopefinish），预定 `/tmp/storeweave-b02-scratch-journal-sol-review.txt`尚不存在。Newlock明確不在該scope以免review無限延伸；consume後再交lock。勿重啟。
- 此輪實質progress無blocker，完整B02仍需journalreader/resume、scratchruntimeverify與CLIpairedflow、explicitB01bridge、.deb/finalchecks，fullB03–B17保持。

### Journal reader 與 scratch 審查修正（2026-09-08 03:28）

- 新 `tools/cli/src/restore-journal.ts` readRestoreJournal：strict schema/UUID dirname/fixedjournalfilename、scratch/quarantinename由UUID派生、distinctname/OIDs、created/restored需OID、live/cluster必須與readPairedSnapshot重新驗證證據一致。Phase只progress，後續仍需actualOIDmap，reader不做DBwrite。抽出read-release-snapshot.ts readPrivateJson供兩種private metadata共用samefd/size/permission規則。16unitPASS `/tmp/storeweave-b02-journal-reader-final-unit.log`，包含forgedid/phase/OID/cluster/checksum/name/extrakey拒絕。
- 已收取Sol `/tmp/storeweave-b02-scratch-journal-sol-review.txt`：cutover/GUC/filefixesPASS，scratch5findings。已修正CONNECTIONLIMIT0原子建立並要求superuser，metadata最後才恢復sourceconnectionlimit；postpg_restore重新readpair；journalroot要求preexisting lstatnonlink/owned0700；source/current PG17gate；URLparsefixedpasswordfreeerror。
- 為exactproperty驗證，將source既有SQL抽成DB `readSnapshotDatabase(client,name?)`，完整pg_catalogqualified，sourcewithReleaseSnapshot與scratch比對共用唯一projection；取代scratch原ACL/settings獨立query。還原完成前核對actualOID及整份propertiesdigest（owner/encoding/locale/rules/collate/ctype/tablespace/limit/comment/ACL/settings）。無domainSQL/migration更動。
- source3＋scratch1 真PG4PASS `/tmp/storeweave-b02-scratch-exact-properties.log`。最新scratch postuse1PASS `/tmp/storeweave-b02-scratch-post-use.log`：native adapter在createdjournal後嘗試normalLOGIN連scratch必須too-many-connections；superuserrestore正常，savedproperties/GUC/ACL/history全部成功。unsafejournalroot symlink/0755、malformedURL sentinel、savedPG16在CREATE前拒絕且DBcount0。成功native restore後adapter改dumpbytes→helper拒絕並failed；既有nativefailure保留tracked scratch/sourceOID亦保持。
- Typecheck PASS `/tmp/storeweave-b02-scratch-safety-typecheck.log`，最後test-only追加後 `/tmp/storeweave-b02-scratch-reader-final-typecheck.log`，diffcheckPASS。Paired restore明確以既有部署PG17為支援契約（version-specific GUCserializer）；未把此gate套到rawbackup/rawrestore或整個runtime。不同major需先更新且驗證metadata還原規則。
- Caller還必須durably建立journalroot（helper不再recursivecreate）；operationroot setup/fsyncparent與resume仍未實作。CREATE-success→OIDjournal間crash保留plannedunknownDB；不得automaticDROP/reuse無證明DB。新增reader尚未接resume或CLI。
- Sol/high activationreviewb02 wA:p1Y已派新scopedre-review scratchfixes＋sharedprojection/reader，預定 `/tmp/storeweave-b02-scratch-reader-final-review.txt`；需下一輪確認live/read。Kernel lockhelper/CLIlockwrapper尚待獨立Solreview，未塞入此scope。此輪有實質progress，無blocker；完整B02/fullB03–B17未完成。

### 持久操作根目錄（2026-09-08 03:34）

- `withTransitionLock` 現在取得kernel鎖後建立／驗證home/.transitions為ownedeffectiveUID、0700非symlink目錄，fsync該目錄、home及homeparent後才action(directory)。這提供scratchjournal需要的preexistingdurableprivate root，callback零參數相容；CLI完整pairedflow尚未用此root寫journal。
- Home只建立單層（parent須已存在），避免recursive新祖先未fsync的缺口；normalnative /opt及isolatedtestparent均已存在。Existinghome不更改權限或ownership；不安全operationroot直接拒絕且釋放kernel鎖，沒有自動chmod他人資料。
- Linuxintegration更新assertcallback收到正確root/UID/mode，0755或symlink operationroot拒絕、不進callback；原nestedlock/nativeinstallerexclude/callbackthrow/SIGKILL同inode釋放/freshinstall與existingcurrent四種拒絕仍PASS。最新版1PASS `/tmp/storeweave-b02-transition-root.log`。CLI unit2PASS `/tmp/storeweave-b02-transition-root-cli-unit.log`（後續只加homeparent同步與singlelevelmkdir，最終Linuxintegration重跑覆蓋），typecheckPASS `/tmp/storeweave-b02-transition-root-typecheck.log`，diffcheckPASS。
- docsdeploymentnative更新privateoperationroot。未跑fullunit或nativeproductionbinarybuild，沒有更改原rootrelease artifacts。
- Sol/high activationreviewb02 wA:p1Y confirmedliveworking上輪scratchfix/reader/sharedprojection scopedreview（state33049），預定 `/tmp/storeweave-b02-scratch-reader-final-review.txt`，尚待consume。Lockhelper＋root尚需separateSolreview，不應插入正在跑的scope造成漂移。
- 此輪實质progress，無blocker。下一步consume review→restorejournal resume與source runtimeverification→CLIpairedsnapshot/restore/cutover整合；explicitB01bridge/.deb/finalfullchecks/B03–B17保持完整目標，B02未DONE。

### Readonly restore verification 與 parent-FD kernel lock（2026-09-08 03:52）

- `readSnapshotHistory` 抽出 source capture 共用的 qualified server-side history/migration checksums 與 bigint sequence projection；`verify-restored-database.ts` 在 READ ONLY repeatable-read 核對 paired snapshot endpoint、cluster/OID、PG17、完整 DB properties/history/generator。仍是 point-in-time，caller 必須保持 writers stopped 並另做 retained source binary cold status。
- 真 PG source3＋scratch1 PASS `/tmp/storeweave-b02-verify-restored-database.log`；追加 wrong OID、microsecond history mutation、connection limit mutation 拒絕 PASS `/tmp/storeweave-b02-verify-restored-negative.log`。Journal planned+nonnull OID 現拒絕，failed nullable/nonnull 均接受；16unit PASS `/tmp/storeweave-b02-journal-phase-unit.log`。
- 收到 lock Sol review `/tmp/storeweave-b02-transition-lock-sol-review.txt` high holder-loss 與 medium unchecked home。已移除 persistent Node holder：parent open FD，native `flock ... 3` 加 shared open-file-description lock 後退出，CLI finally close。Callback 接收 lockFd；目前 upgrade migration exec 明確繼承 FD3，CLI SIGKILL 後仍由 migration child 保持鎖直到 child 結束。後續 paired pg_dump/pg_restore 整合也必須傳遞 FD，尚未接線，不能宣稱完整 transition crash safety。
- CLI 與 shell installer 均驗證 home 非 symlink、owned、無 group/world write；lock regular/single-link/owned/無 group/world write。Installer 新 home explicit0755、lock private0600，不依賴 umask；現有目錄不自動 chmod。CLI stderr nullable typecheck error 已修正。
- 真 Linux integration PASS `/tmp/storeweave-b02-descendant-lock.log`：nested lock/native exclusion、bad home0777/symlink、bad operation root、callback failure、parent SIGKILL 同 inode reacquire；新增 migration-shaped child 繼承 FD，殺 parent 後競爭 lock 仍拒絕，殺 child 才可取得。CLI2unit PASS `/tmp/storeweave-b02-descendant-cli-unit.log`；typecheck PASS `/tmp/storeweave-b02-trusted-home-typecheck.log`；diffcheck PASS。未重建原 release artifacts。
- Sol/high activationreviewb02 wA:p1Y confirmed working，限定新 readonly verify/shared history review `/tmp/storeweave-b02-verify-database-sol-review.txt`；lock fixes 尚需後續 scoped review。原 review 額外 interoperability coverage shell→CLI/Base identity/final current race，以及 PG16 target/non-superuser/wrongUID scratch negatives仍待補。
- B02 step2 持續，尚需 source binary check、journal resume、完整 paired CLI flow、explicit B01 bridge、deb 與 final checks；B03–B17 全範圍保留。此輪實質 progress，無 blocker，未 commit/push/deploy。

### Native PostgreSQL 工具繼承操作鎖（2026-09-08 03:56）

- 上輪為 progress：已修改及驗證 parent-owned flock、trusted home、migration descendant FD；本輪沒有重新啟動 reviewer 或重做 broad inventory。
- `pg-tool.ts` 原 execFile 無法傳額外 FD，改 Node spawn 同一小型 bounded-output runner；stdout/stderr 各上限16MiB，超限 SIGKILL 並等 close，非零退出保留 stderr，原 credential redaction/owned cleanup 仍由 runPgTool 管理。無新依賴。runPgTool/writePgBackup optional lockFd→child FD3；offline pg_restore --list 同樣繼承。createPairedSnapshot options.lockFd、restoreSnapshotToScratch 第五參數傳到底層。原 raw backup/restore 無鎖呼叫保持有效。
- `native-install-guard.test.ts` crash descendant regression 改實際 bundled runPgTool + native executable fixture：真 Linux flock，native工具建立ready PID，殺CLI parent後競爭 lock拒絕，殺native child後重新取得。沒有只用一般 spawn 代替工具接線。真pg-tool整合仍跑實際PG17dump/restore完整metadata驗證。
- 初版 unit55中1失敗：offline pg_restore 錯誤訊息漏 stderr；已修正後56PASS `/tmp/storeweave-b02-pg-lock-unit-r2.log`（包含新17MiB超限與privatepassfilecleanup）。兩個integration PASS `/tmp/storeweave-b02-native-pg-lock.log`（native lock1、真PG1）。typecheck log `/tmp/storeweave-b02-native-pg-lock-typecheck.log`，diffcheck PASS；沒有修改root release artifacts。
- Sol/high activationreviewb02 wA:p1Y confirmed still working readonly verification/shared history scopedreview，預定 `/tmp/storeweave-b02-verify-database-sol-review.txt` 尚未產生；不可因等待時間restart。Lock/pg-tool spawn新的scoped review仍須在本scope完成後交付。
- CLI完整pairedflow尚未呼叫上述optional lockFd helpers，必須接上，不得將此helper接線視為B02完成。下一個主要slice仍source retained binary cold verification、restore journal resume/cutover orchestration與upgrade/rollback替換；explicitB01bridge/deb/finalchecks/B03–B17完整保留。此輪有實質progress，無blocker。

### Retained source CLI cold check 與 history/URI 根因修正（2026-09-08 04:01）

- 上輪分類progress，實際修正native工具FD與通過checks。本輪新增 `verify-source-runtime.ts`：readpair後直接執行保留的runtime/bin/node＋app/cli.js migrate --status --json；private0700temporary＋600config保留原始未插值設定，只覆寫database URL為一次插值env、autoMigratefalse/logstderr；30s/SIGKILL/1MiB bounded output、optionalFD3、固定無secret錯誤；require releaseCurrenttrue/pendingempty/appliedarray，再readpair核對。未執行migration或extensionsetup；仍需caller先後verifyRestoredDatabase與writerdrain。
- 首個真build CLI測試 red `/tmp/storeweave-b02-source-runtime-integration.log`：scratch保留search_path含retained/public，ensureHistory未限定schema在retained建立shadow空history，statusfalse。修正兩個共用DB檔 migrator.ts/release-history.ts 的三個history表與FK references/query全部明確public，沒有改domainSQL。Root fix同时覆蓋baseline/capture/status/activation，而非只改新helper的search_path。
- Sol review已收 `/tmp/storeweave-b02-verify-database-sol-review.txt`：medium URI query routing overrides與shadow-historyattestation不一致；後者上述共用SQL修正。前者抽原pg-tool URI policy成parsePgUrl共用，pairedcreate/restore/verify/source-runtime/cutover均使用，增加database selector拒絕，保留credentialambiguity/plus/empty檢查。URL錯誤維持credential-neutral。
- 真PG integration fixture現在複製實際build的Base CLI與hostnode到保留source tree（其他app仍structural，非完整native發布smoke）。完整dump→scratch→verifyDB→實際sourceCLI→verifyDB成功；assertretained schema無platform shadow tables；missingDB與刪scratchreleasehistory後statusnotcurrent拒絕。四個URIhost/port/database/dbnamequery覆寫拒絕。最新PASS `/tmp/storeweave-b02-source-runtime-final.log`；初次fixPASS `/tmp/storeweave-b02-source-runtime-r2.log`。
- Shared history SQL後fullunit57files696PASS `/tmp/storeweave-b02-history-qualified-unit.log`；migration-history17＋snapshot3=20PGPASS `/tmp/storeweave-b02-qualified-history-integration.log`。後URLextract pg-tool40PASS但snapshotmock缺parsePgUrl全16red `/tmp/storeweave-b02-pg-url-shared-unit.log`，改為partialmock保留真parser後16PASS `/tmp/storeweave-b02-pg-url-snapshot-unit-r2.log`。最終typecheckPASS `/tmp/storeweave-b02-source-runtime-complete-typecheck.log`，diffcheckPASS。
- Sol/high activationreviewb02 wA:p1Y confirmedworking新限定scope：上述兩個findingsfix＋sourceverifier，預定 `/tmp/storeweave-b02-source-runtime-sol-review.txt`。Lock trustedhome/parentFD/pgspawn新code仍待後續scopedreview，不塞入此scope。未commit/push/deploy/覆寫原release。
- 尚欠原review精確negative：source shadow-first pool＋validshadow/corruptpublic在capture前拒絕；restoredgenerator value/isCalled、releasehistory timestamp、backendcleanup、callerOIDprovenance。Sourcehelper未接完整pairedCLI/resume。Next main slice restorejournal resume/cutover durablephase與actualOID辨認；完整upgrade/rollback/explicitB01bridge/deb/finalchecks/B03–B17保持，B02未DONE。此輪有實質progress，無blocker。

### Restore journal → verified cutover/resume（2026-09-08 04:08）

- 上輪progress：sourceCLI驗證與history/URI fixes有真實checks。本輪新增 `resume-restore.ts`，從readRestoreJournal的scratchOID建立intent（不接受caller挑OID），inspect實際initial/committedmap，scratch DBverify→retained CLIstatus→DBverify，fsync cutover-intent後atomicrename，再persistcutover-committed與live同組驗證。回傳sourceDirectory/journal/quarantinename，尚未切current/startservices。caller必須持transitionlock並停止managed/externalwriters。
- `database-cutover.ts` 共用原cataloglock/cluster/OIDvalidation，新增inspectCutover只辨認不rename。已committedmap需journal既有cutover-intent/committed；journalcommitted但actualinitial拒絕。created/failed/planned一概拒絕resume，不DROP/reuse未知或不完整scratch。Intentlostpostcommit可從actualOIDmap繼續，phase不代替資料庫事實。
- `restore-journal.ts` schema增加cutover-intent/cutover-committed（兩者需scratchOID），抽出唯一writeRestoreJournal 600temp/fsync/rename/fsync兩層parent。restoreSnapshotToScratch改共用writer，刪supersededsynchelper，無未使用verifiedphase。
- 初版抽出writer誤刪sync後的settingValue，typecheck/realPG立即red `/tmp/storeweave-b02-resume-typecheck.log`、`/tmp/storeweave-b02-resume-integration.log`。已從先前Sol工具readout的原始16行還原exactfunction（非重寫）；完整GUCrestore/regression重跑PASS。搜尋original的ownrg63308已停止；沒有動unrelatedprocess。
- 真PG整合新增freshscratch→關閉source runtime pool→resume切換→rewindjournal為durableintent模擬COMMIT後progresswrite遺失→resume識別alreadycommitted；確認live=newOID、quarantine=oldOID、scratchname消失、sourcecodepath回傳。另failedattempt拒絕、committedphase/initialmap拒絕、committedmap/restoredphase無durableintent拒絕。最新PASS `/tmp/storeweave-b02-resume-negative.log`，正向前版PASS `/tmp/storeweave-b02-resume-integration-r2.log`。這是journal-state模擬，尚非actualprocessSIGKILL的COMMIT兩側測試。
- 原atomiccutover含lateconnections/DDLlock/errorrollback等1整合PASS `/tmp/storeweave-b02-inspect-cutover.log`。Journal16unitPASS `/tmp/storeweave-b02-resume-unit.log`，typecheck `/tmp/storeweave-b02-resume-complete-typecheck.log`，diffcheckPASS。未重建原release/未commitpushdeploy。
- Sol/high activationreviewb02 wA:p1Y仍confirmedworking先前source-runtime/SQL/URI scope（6m27），預定 `/tmp/storeweave-b02-source-runtime-sol-review.txt`未產生，勿restart。新resume/writer/inspect需要後續Solscope，lock/pgspawn仍排後續，未把新scope塞入liveagent。
- 主流程尚未接CLI：fullpairedupgrade/rollback需externalwriterack、journal/sourcecandidatebinding、forwardretry、resume→atomiccurrent/start；explicitB01bridge、deb/finalchecks、B03–B17完整保留。既有blindrollback body未替換，B02未DONE。此輪實質progress，無blocker。

### CLI paired rollback 接線與 private source execution（2026-09-08 04:13）

- 上輪progress：resume/journal/OIDcutover helpers已有真PG證據。本輪main.ts移除blindsymlinkrollback與--to，新增rollback --snapshot/--checksum或--resume、每次--yes與--external-writers-stopped、maintenance-database、--no-restart。持同kernel lock、readpair/release/current/configbinding→stopmanagedservices→freshscratch或resume→verifiedDBcutover→fsyncedatomiccurrent→optionalstart。failure不自動DBrollback/start；舊previous不是rollback依據。
- Current identity一開始只realpathcurrent對literal保存路徑，真CLI測試在macOS /var→/private/var alias red；已對source/candidate兩者也realpath再比對，未放寬實際目標綁定。首次import插到shebang前typecheckred，立即修正shebang第一行。最終typecheckPASS `/tmp/storeweave-b02-cli-rollback-final-typecheck.log`。
- 實際builtBaseCLI rollback --resume在真PG17scratch完成cutover/current，測試assertcurrent=source並保持quarantine+resumerecognition；PASS `/tmp/storeweave-b02-cli-paired-rollback-r2.log`。macOSflockshim只驗證CLI接線，真LinuxFD互斥已由nativeguard測試，不混稱nativefullsmoke。CLI fresh--snapshot分支尚待實際CLI端到端測試；其底層freshscratch仍真PG覆蓋。
- CLI5unitPASS `/tmp/storeweave-b02-cli-paired-rollback-unit.log`，新增缺兩個ack任一者在home建立前拒絕。docsdeploymentnative移除舊--to與未contract就一定安全的錯誤保證，記錄現代paired指令、maintenance/drain/quarantine/retry限制，清楚標示upgrade自動snapshot仍未接線。
- 已收Sol `/tmp/storeweave-b02-source-runtime-sol-review.txt`：SQL/URI修正PASS，highsourceexecutionpathname race。verifySourceRuntime現cp完整source到existingprivate temp/source，再validateReleaseDirectory比對id/version/name/manifestChecksum/treeChecksum後只executeprivatecopy，仍最後readpair驗原始tree。用既有copy/validator無新依賴。
- 新兩個deterministic sentinel regression：初始readpair後、privatecopy時replace source runtime/bin/node或app/cli.js，必須beforeexecutionreject且sentinel未執行。另parserownertable補database拒絕。2files59unitPASS `/tmp/storeweave-b02-source-copy-unit.log`，diffcheckPASS。實際CLIintegration含privatecopy亦PASS。
- Sol/high activationreviewb02 wA:p1Y confirmedworking針對private-copyracefix＋sentinel限定review，預定 `/tmp/storeweave-b02-source-copy-sol-review.txt`。新resume/CLIpairedflow仍需separateSolreview，lock/pgspawnreview也尚待；不把pendingsecurityreview視為B02完成。
- 下一main slice modernupgrade pairedsnapshot/durablejournal/forwardretry，並補freshrollbackCLI、actualcrashboundaries；explicitB01bridge（不可用B02→B02替代）、deb/finalnative/fullchecks、B03–B17仍完整保留。B02未DONE，未commit/push/deploy/改原release；此輪有實質progress，無blocker。

### Modern paired upgrade／retry／fresh rollback end-to-end（2026-09-08 04:24）

- 上輪progress：CLIpairedrollback＋privatecopyracefix有實際checks。本輪新增upgrade-journal.ts，prepared/migrating/migrated/activated＋immutablepairpath/checksum，UUIDhome/fixedupgrade.json/strictschema，read時重新驗pair。requireUpgradeDatabase共享parsePgUrl/DBprojection核對endpoint/name/cluster/OID，容許部分migrationhistory但不容許livephysicalDB被換。create要求owned0700root。共用writePrivateJson移至read-release-snapshot.ts，restorewriter與upgradewriter各自先schema驗證再共用fsync/atomicrename，刪重複實作。
- Main upgrade現在--release或--resume互斥、必須fresh--external-writers-stopped。newcandidatearchivevalidate/install→stopmanaged→source runtime withReleaseSnapshot/createPairedSnapshot→輸出pair/checksum→durablejournal→identitycheck→migrating→privatecandidateCLI migrate/statuscurrent/no pending→revalidatepair與DBidentity→migrated→fsyncedcurrent→activated→optionalstart。失敗由現有CLI非零exit，無automaticDBrestore/start。Removed supersededpreviouswrite；docs改pairedflow与--resume。
- 共用run-release-cli.ts從已reviewedsourcecopy邏輯抽出：完整privatecopy/fulltree身份比對、private raw config/databaseoverride、可選FD3；status30s，migration不擅自設固定30s（可長期執行），stdout/stderrbounded1MiB，errorscredential-neutral。verifySourceRuntime只使用status並finalreadpair。既有sourceprivatecopySol scopedPASS `/tmp/storeweave-b02-source-copy-sol-review.txt`；新共用executor與upgrade整體仍需後續review。
- 新tests/integration/cli-upgrade-paired.test.ts用兩個真buildBaseCLI0.2.0/0.2.1、hostnode與structural其他apps、真PG17/nativepgclients。ManagedchildPID/SIGTERMmarker由pg_dumpadapter核對dump必須在服務停止後。用test-onlyNODE_OPTIONS hook注入candidate migrateexit23：CLI非零、currentold、snapshot/journalmigrating保留；移除marker後同journalresume成功、再resume不加history（仍2）；fresh CLIrollback --snapshot/checksum成功、currentold、DBhistory恢復0.2.0。
- 初版fixturearchive叫candidate被validator拒絕（正確）改storeweave-0.2.1。第二輪syncCLItest阻塞testparent回收child造成stoptimeout，改async execFile，沒有弱化productionstop。第三輪只因macOS/var/privatealias字串assert紅，改realpathassert。最終完整1PASS `/tmp/storeweave-b02-paired-cli-e2e-r4.log`（30.1s）。Macflockshim只證CLI流程，真Linux互斥仍獨立nativeguard，不稱完整nativepublishsmoke。
- 舊未pairedupgrade unit fixture已由真CLIe2e取代其manageddrain行為；cli-upgrade.test.ts保留6個inputgate（beforehomecreate），snapshot19unit包含upgradejournal strictidentity/phase/immutablepair。Focused25PASS `/tmp/storeweave-b02-paired-upgrade-unit.log`；新requireUpgradeDatabase真sourceaccept／rollback後same-name-newOIDreject連同全部pg-tool1PASS `/tmp/storeweave-b02-upgrade-identity-integration.log`。最終fullunit57files704PASS `/tmp/storeweave-b02-paired-upgrade-full-unit.log`，typecheckPASS `/tmp/storeweave-b02-paired-upgrade-final-typecheck.log`，diffcheckPASS。
- Sol/high activationreviewb02 wA:p1Y confirmedworkingresume/rollbackCLI/sharedjournalwriter/inspect scope，預定 `/tmp/storeweave-b02-cli-rollback-sol-review.txt`；主代理未把upgrade新scope加入。後續還需modernupgrade/journal/runReleaseCli與lock/pgspawn的Solreview。
- 明確剩餘：snapshotpublication→upgradejournalcreation crash窗口目前可有orphanpair，rollback可用pair但forwardresume還需recovery路徑；actualSIGKILL在snapshot/COMMIT/journal/current兩侧驗收、partialmigrationfailure retry、sourcecopypostcopy-originalmutation互補test、先前negativecoverage。ExplicitB01bridge仍未實作（不可用本modern0.2→0.2替代）；deb/finalnativeDocker/fullintegration/ADR/B03–B17保留。B02未DONE，此輪實質progress，無blocker，未commitpushdeploy或改rootrelease。

### Published-pair crash recovery 與 post-copy sentinel（2026-09-08 04:28）

- 上輪progress：modernupgrade/retry/freshrollback已真PG與704unit驗證。本輪main upgrade新增第三個互斥入口--snapshot/--checksum；要求freshexternalwriterack，readpair/currentreleasepath/DBphysicalidentity核對後durablecreate新upgradejournal，再走同候選migration/status/current流程。可恢復snapshot已publish而journal尚未完成的窗口，不重新snapshot、不刪中止journal目錄；docsnative補命令。
- 真CLIe2e test-onlyNODE_OPTIONS hook在首次upgrade.json rename前真正SIGKILL CLI（snapshot已fsyncpublish）。OwnedPGhistory仍1；取保存pair/checksum後--snapshot繼續，注入migrationexit23保留current/journal，再--resume向前成功且再次resumehistory仍2，最後freshpairedrollback成功。最新1PASS `/tmp/storeweave-b02-orphan-pair-recovery.log`。NativeLinuxflock仍另測；本測macOSshim只驗檔案/PG/CLIcrash流程。
- 補Sol sourceprivatecopy的精確互補順序：cpSync先完成cleanprivatecopy，再replace原runtime/bin/node或app/cli.js；boundpayload確實執行、sentinel永不執行，最後readpair拒絕原artifactchanged。與既有precopytaintreject一起涵蓋兩側。21snapshot＋6CLIgates=27unitPASS `/tmp/storeweave-b02-orphan-copy-unit.log`。最後typecheck `/tmp/storeweave-b02-orphan-final-typecheck.log`，diffcheckPASS。
- Sol/high activationreviewb02 wA:p1Y仍confirmedworkingrollback/resume/writer/inspect限定scope（最近9m56），`/tmp/storeweave-b02-cli-rollback-sol-review.txt`尚未產生；已提醒不要把native supervisor或B01全設計混入此scope，但未restart。Modernupgrade/journal/sharedexecutor以及kernel lock/pgspawn仍待接續Solreview。
- 待辦完整保留：actualcrash於DBCOMMIT/journal/current兩側、partialSQLmigrationfailure與source shadow-capture/sequence/privilege等精確negatives；explicitB01bridge不能用本modern測試替代；deb/finalnativeDocker/fullintegration/ADR及B03–B17。B02未DONE。本輪實質progress，無blocker；未commit/push/deploy/修改原release。

### Actual cutover crashes＋trusted journal provenance＋restart cleanup（2026-09-08 04:38）

- 上輪progress：orphanpairSIGKILLrecovery與postcopysentinel真checks。本輪已收Sol `/tmp/storeweave-b02-cli-rollback-sol-review.txt`：highjournalroot/provenance與二次readmutableauthority、mediumendpointchecklate、mediumpartialrestartfailure。已修正如下，尚待scopedre-review。
- read-release-snapshot.ts新增assertJournalLocation：file必須是lockedoperationroot直接UUIDchild內；root/home owned0700 nonsymlink，existingjournalregularsinglelinkownedeUID0600。readRestoreJournal/writeRestoreJournal與upgrade counterparts現在必須接收operationRoot；main兩種resume皆傳withTransitionLock給的root。Freshscratchwriter也傳同root。Main preflight read的整份record直接交resumeRestoreCutover，resume不再二次read可變journalpath。Writer再次驗location/ownership再持久replace；沒有把secondjournal內容變成authority。
- resumeRestoreCutover在inspect之前pinPGport＋compareendpointdigest，任何phase均先拒絕wrongendpoint，不能先將clone觀察結果寫成committed。Unit證cutover-intent端點錯誤在unusedconfig/不可用PGendpoint之前明確endpointmismatch，journalbytes不變。
- service.ts startServices改async在sharedfunctioncatch partialfailure→awaitstopServices，cleanup失敗AggregateError；main start/restart/upgrade/rollback所有callerawait。Unit真APIchild已spawn後workerentry缺失，確認APIdead與兩個PIDfile無殘留，並保留既有drain/timeout/unsafePIDregression。
- 真CLI/PGintegration extended actualSIGKILL：durablecutover-intent後、renameDB前kill→liveOIDold；重試在DBCOMMIT後/committedjournalrename前kill→liveOIDnew、journal仍intent、currentcandidate；再resume在currentrename前kill→journalcommitted但currentcandidate；最後resume完成sourcecurrent。另outsideoperationroot合法shapejournal在preflight拒絕。Configread hook在main已readjournal之後替換該file為untrustedJSON，finalresume仍使用已驗證record並正確覆寫progress，替換內容未成authority。
- 最後真CLI測試移除--no-restart並只讓/current/app/worker.js檢查失敗，sourceAPI長存fixture已開始：command非零，PID目錄無pid，DB/current/journal/quarantine保持，之後--no-restart resume成功。PASS `/tmp/storeweave-b02-cli-restart-cleanup.log`（41.8s）。先前swap/crash版PASS `/tmp/storeweave-b02-journal-swap-crashes.log`；新版pg-tool trustedrootfixture調整使journal位於同CLIhome/.transitions，與crashes兩個整合PASS `/tmp/storeweave-b02-provenance-crash-integration.log`。首個crashtest SIGKILLassert曾紅、加diagnostics並完成fix後全部pass，未把red算pass。
- 聚焦28unitPASS `/tmp/storeweave-b02-provenance-final-unit.log`，finalfullunit57files707PASS `/tmp/storeweave-b02-provenance-full-unit.log`，typecheckPASS `/tmp/storeweave-b02-provenance-complete-typecheck.log`，diffcheckPASS。docs-native補resume root限制與partialrestartcleanup。沒有改domainSQL/rootrelease或外部state。
- Sol/high activationreviewb02 wA:p1Y confirmedworking三項fix限定複審，預定 `/tmp/storeweave-b02-rollback-provenance-sol-review.txt`。Modernupgrade/journal/sharedexecutor仍需separateSolreview，kernelparentFD/pgspawn也待review。此輪有實質progress，無blocker；B02未DONE。
- 全scope剩餘仍explicitB01bridge（真舊binary，不可modern替代）、deb、finalnativeDocker/fullintegration/ADR、各精確negative與B03–B17。新actualSIGKILL證明COMMIT前後及current前的程序crash，不是powerloss，也尚未kill在兩條ALTERDATABASE中間（該atomicrollback由既有PGcutovererror/connectioncase證明）。DifferentUID0700journalnegative需rootLinuxfixture；目前ownercheck碼與sameUIDoutside/badmode有測試。

### Explicit B01 recognizer 與 bounded tree 共用（2026-09-08 04:44）

- 上輪progress：journalprovenance/endpoint/restartcleanup與actualcrashes都有真checks。本輪讀取既定 `/tmp/storeweave-b02-legacy-bridge-design.txt` 與B02前baselinebuildscript；確認B01 build-info固定version/builtOnNode/entries三keys，entries為/dist/app/api.js、worker.js、cli.js。`/tmp/storeweave-b01-build-path`是三個hostprobe bundles（沒有build-info）；真正保留nativeartifact在release/commerce-0.1.0，未錯把probe視為完整release。
- release-validation.ts新增validateLegacyB01Directory，只供explicitbridge呼叫，modernvalidate不fallback。VERSION0.1.0、Commerce既有nativefiles/executable與strictoldmetadata；任何RELEASE/release-manifest.json/scripts/validate-release.js/app/seed.js modernmarker即拒絕，含損壞marker。回傳formatlegacy-b01+id/version/name/fulltreechecksum，沒有偽造modernmanifestChecksum。
- 將原boundedlstat/hashwalk抽成private withReleaseTree(directory,readMetadata)，modern/legacy兩個實際parser共用。Metadata仍在首次hash後與finalfile/directoryidentityrecheck前讀取，沒有失去既有metadata讀取時被改檔的regression保障。MAXbytes/members/path/links/permission/sameFD限制不變，rootdigest仍綁所有路徑modebytes。
- 唯讀真正保留B01nativeartifact驗證PASS `/tmp/storeweave-b02-real-b01-recognizer.log`，treeChecksum sha256:44650e226713f3fb6d0760d7fcafff17952db3377f0e1c8f34412e4add2eae2b。獨立重新核對 `/tmp/storeweave90-preserved-release-hashes.json` 2461pins，changed=[]；沒有覆寫rootrelease。
- Focused releasevalidation50＋snapshot21=71unitPASS `/tmp/storeweave-b02-legacy-recognizer-unit.log`，含explicitoldlayout/byteschange/no fabricatedmanifest、4modernmarkers拒絕、3strictmetadata違反、symlinkexecutable拒絕；既有modernrace/snapshottests保持。TypecheckPASS `/tmp/storeweave-b02-legacy-recognizer-final-typecheck.log`，diffcheckPASS。未新增dependency/domainSQL或nativepublish。
- 已收Sol `/tmp/storeweave-b02-rollback-provenance-sol-review.txt` scopedPASS（3fix無materialdefect），剩nonblockingwriter-outroot/0644不replace/no-temp與單獨wrongport精確tests。新Sol/high activationreviewb02 wA:p1Y派modernupgrade/journal/runReleaseCli限定review，預定 `/tmp/storeweave-b02-modern-upgrade-sol-review.txt`，後續confirmactualstatus；kernellock/pgspawn仍另待review。
- B01 recognizer尚未接CLIflag，不能宣稱B01bridge完成。Next bridge slice：sourcecurrent inside releases binding、raw immutable safety snapshot BEFOREbaselineDDL、fixedbaseline兩falseflags、postbaselinepairedschema/legacyselection捕捉、journalbind兩dump及catalog、candidateforwardretry與actualB01rollbackverify。需讓modernsource嚴格schema不被放寬，legacy明確分支且不以modern測試替代。
- B02/fullB03–B17仍未DONE；deb/finalnativeDocker/fullintegration/ADR/精確negative持續待辦。此輪實質progress，無blocker，未commitpushdeploy。

### B01 pre-baseline safety capture／reader（2026-09-08 04:51）

- 上輪progress：explicitB01recognizer/真舊nativeartifactread/71unit。新DB withLegacySafetySnapshot 在既有advisorylock8140231下BEGIN RR READONLY，pg_catalog/UTC/ISO設定後取physicalDBproperties、public.platform_migrations完整serverJSONchecksum與pg_export_snapshot；callback後COMMIT，withMigrationLock解鎖成功才resolve。完全不呼叫ensureHistory/baseline，不新增第二個Runtime介面；既有現代withReleaseSnapshot保持。
- 新CLI legacy-safety-snapshot.ts createLegacySafetySnapshot：owned0700operationroot、explicitURLpolicy、B01source與distinctversionCommercecandidate完整treevalidate→私有staging→writePgBackup(exported snapshot)→dumpSHA/size＋source/candidate再驗證→fsyncedsafety.json→DBcommit/unlock後再驗artifact→UUIDexclusivefinalreservation/rename/fsyncroot。失败只清自己staging，保留任何finalreservation。descriptor不存password或transientsnapshotId，不偽造legacyhistoricalverification。
- 同檔readLegacySafetySnapshot檢查expecteddescriptorchecksum、strictkind/id/UUIDdirectory、legacyartifact與moderncandidate全treeidentity、dumpbytes/hash/privateFD。共用read-release-snapshot.ts的pairedSnapshotSchema子schema（DBproperties/candidate/dump）及抽出的verifyPrivateDump，避免兩種dump驗證規則漂移；modernreadPaired仍相同規則。
- 新真PG17整合：固定catalog產生49個舊history ID/phase，只有三欄history與legacy_probe資料（不是宣稱已跑完整B01binary/domainSQL）。rawdumprestore到新DB後49rows/7data核對，來源仍三欄、無platform_release_history/platform_migration_baselines。故意pg_dumpfail不publish新snapshot、不改oldrows；descriptor/dump/oldCLIbyte tamperreader拒絕。PASS `/tmp/storeweave-b02-legacy-safety-reader-integration.log`（new1＋existingmodernsource3=4tests）。第一版raw1PASS `/tmp/storeweave-b02-legacy-safety-integration.log`。
- 共用dumpreader後snapshot21unitPASS `/tmp/storeweave-b02-shared-dump-reader-unit.log`；typecheckPASS `/tmp/storeweave-b02-legacy-safety-complete-typecheck.log`，diffcheckPASS。未改domainSQL/既有rootrelease或執行baseline採納；無commitpushdeploy。
- Sol/high activationreviewb02 wA:p1Y confirmedworkingmodernupgrade/journal/executor限定scope，預定 `/tmp/storeweave-b02-modern-upgrade-sol-review.txt`尚未產生；未把B01新helper塞入review。B01recognizer/capture/reader需後續Solreview，kernellock/pgspawn仍排後。
- Next required bridge slice：CLIexplicitflag及sourcecurrent-inside-releases、rawsnapshotjournal→baseline固定catalog/兩falseflags→postbaselinepaireddescriptorlegacy分支/既有withReleaseSnapshot legacyselection（不加Runtime接口）→candidateforwardretry/actualoldbinaryrollback。Raw安全snapshot目前還未接CLI，也沒有完整raw prepairedfailure restore命令；需完成，不能以rawhelpergreen宣稱bridge完成。B02/deb/finalnativeDocker/fullintegration/ADR/B03–B17完整保留；此輪實質progress，無blocker。

### 升級重試修正與 current 崩潰續跑（2026-09-08 05:04）

- 收到 Sol modern-upgrade review 的兩項 HIGH：候選目錄已安裝但 drain／dump 失敗會卡住重試；孤立快照採用只檢查 physical identity，未確認來源 history。修正 `release-validation.ts`：archive 安裝可明確選擇重用既有候選，完整 identity／manifest／tree digest 必須一致；一般 native install 仍拒絕既有目錄。`main.ts` 的 `upgrade --snapshot` 在建立 journal 前停止服務並執行 exact DB → source CLI status → exact DB；`--resume` 保留容許部分 migration 的 physical identity 檢查。
- 真 PG17／actual CLI regression 包含 invalid worker PID 導致 drain 失敗、native pg_dump 失敗後同候選重試、孤立快照來源 applied_at 差 1 microsecond 拒絕且不建立 journal。51 validation unit PASS `/tmp/storeweave-b02-candidate-reuse-unit.log`；完整 CLI PASS `/tmp/storeweave-b02-upgrade-retry-fixes.log`。
- 補 actual SIGKILL 在 upgrade current rename 前、rename 後但 activated journal 前。兩次皆保留 migrated journal；前者 current 仍來源、後者已為候選，同 journal 重試成功且 effective history 不重複。完整 upgrade／rollback crash integration PASS `/tmp/storeweave-b02-upgrade-current-crashes.log`（1 scenario，52.48 秒）。這是程序崩潰測試，不宣稱 power-loss durability。
- `release-history.ts` 抽出既有 baseline selection 邏輯為 `legacyBaselineSelection`，供 adoption 與 post-baseline capture 共用；既有 integration 在 adoption 後以此 selection 執行 withReleaseSnapshot，17 PASS `/tmp/storeweave-b02-legacy-selection-integration.log`。尚未接完整 B01 CLI bridge／固定 49 SQL post-baseline paired descriptor。
- 完整 unit 57 files／717 PASS `/tmp/storeweave-b02-upgrade-fixes-full-unit.log`；typecheck PASS `/tmp/storeweave-b02-upgrade-final-typecheck.log`；git diff --check PASS。無新 dependency／domain SQL／外部寫入，沒有 commit、push 或 deploy。
- 已續派 native Herdr activationreviewb02（wA:p1Y，既有 Sol/high YOLO agent）唯讀複查兩項 HIGH 修正，確認 working，結果待收。kernel FD／pg spawn 與 B01 helper Sol review 仍另待辦。實際部分 SQL commit 後失敗／雙候選 shared-prefix regression 尚未完成；目前 migration failure hook 在 SQL 前 exit 23，不能作為其證據。
- 下一步維持 B02：收 Sol 修正複查，完成上述精確 migration 測試、B01 raw→baseline→paired journal／CLI／actual old-binary recovery、deb parity、final rebuilt native/Docker smokes、完整 integration／ADR／Standards+Spec。B03–B17 不縮減。此輪有實質進展、無 blocker。

### 現代升級兩項 HIGH 複查通過（2026-09-08 05:08）

- Sol/high activationreviewb02 對 exact candidate reuse 與 orphan exact-source adoption 給 scoped PASS，無此限定邊界的剩餘 defect。完整輸出 `/tmp/storeweave-b02-modern-upgrade-fixes-sol-pass.txt`。明確維持 durable same-candidate journal 的 physical-only resume，允許部分 migration；不能推論為 B02 全包通過。
- 已派同一 native Herdr Sol/high agent 審查 parent-owned flock FD、pg spawn bounded output／redaction／cleanup、native child FD inheritance、installer interoperability；確認 working。此 review 不含 B01 bridge 或 deb。

### 真實部分 SQL migration／雙候選續跑回歸（2026-09-08 05:09）

- `tests/integration/cli-upgrade-paired.test.ts` 已移除 SQL 前 exit 23 的 migration failure hook。測試以既有 esbuild 建出真 CLI 與相符 manifest，僅測試候選新增 upgrade-probe module，production build 無新 hook／參數。0.2.1／0.2.2 共用第一筆 CREATE TABLE＋INSERT SQL，第二筆 SQL 不同；第二筆先因資料 gate=false 真正拋 PostgreSQL exception。
- 兩個候選各先建立孤立 pair。採用 0.2.1 後查真 DB，僅 upgrade-probe/0001_first 已記 history，資料僅 id=1，journal=migrating、current 仍來源。此時採用共享首筆 SQL 的 0.2.2 pair，exact history mismatch 拒絕且不新增 journal。只修改 owned fixture 的 gate 資料為 true（不改 SQL bytes／history），同 0.2.1 journal 續跑成功，資料為 1、2，沒有 0.2.2 的 3。
- 保留 drain／dump retry、microsecond source drift、upgrade current 前後 SIGKILL、rollback intent／commit／current SIGKILL 與 partial restart cleanup。最終 paired rollback 後 release history 回 0.2.0，新增 upgrade_probe relation 不存在。這證明部分 SQL 已提交後 forward retry 與來源 schema rollback；仍不是完整 B01 bridge 測試。
- 第一輪測試 fixture 的本地 build 字串遮蔽 esbuild function，typecheck／integration 都失敗；改用 import build as bundle 後修正。第二輪真 SQL scenario PASS `/tmp/storeweave-b02-partial-sql-cli-r2.log`；新增 rollback relation absence assertion 後最終 PASS `/tmp/storeweave-b02-partial-sql-cli-final.log`（56.02 秒）。最終 typecheck PASS `/tmp/storeweave-b02-partial-sql-typecheck-final.log`、git diff --check PASS。
- 僅測試與紀錄變動，無 production SQL／dependency／root release 改動，未 commit／push／deploy。此回歸取代先前 pending partial-SQL/shared-prefix 項目；B01 bridge、deb parity、final rebuild/smokes/fullintegration/ADR/最後 Standards+Spec 仍待完成。kernel FD／pg spawn Sol reviewer 此時確認 working，待收結果。B02 與完整 B03–B17 持續 active，無 blocker。

### B01 固定 SQL prefix 選取與保留程式實測（2026-09-08 05:12）

- `legacyBaselineSelection(baseline, sets, enabledExtensions)` 現在共用原本 baselineMigrations 的 catalog bytes／phase／order 比對，並回傳只含固定 pins 的 active migration sets。候選新增 SQL 不會混入 post-baseline source capture；baselineMigrations 仍使用同一 validation，無第二套比對規則或新 Runtime API。
- integration 新增：來源僅固定第一筆、候選包含第二筆，baseline 後完整候選 sets 被 withReleaseSnapshot 拒絕，固定 source sets 可 capture；未執行後續 SQL、既有 SQL bytes drift 拒絕、兩個 false flags 保留。18 PASS `/tmp/storeweave-b02-legacy-prefix-final-integration.log`；typecheck PASS `/tmp/storeweave-b02-legacy-prefix-typecheck.log`；git diff --check PASS。
- 擴充既有 old-binary probe 到 `/tmp/storeweave-b02-old-binary-capture-probe.cjs`，使用保留 B01 host bundles 實跑 49 migrations／商品與舊 API，現代 CLI baseline 後以固定 selection＋migrations 執行 withReleaseSnapshot，核對 49 pins 與 false flags，再驗新 API、舊 CLI/API、原 history/商品保留。PASS `/tmp/storeweave-b02-old-binary-capture-probe.log`，來源 `/tmp/storeweave-b01-build-path` 指向的 preserved host bundles。只在新 temp build 與 owned PG17 fixture 執行，沒有改 root release。
- 此 probe 驗證 post-baseline exported snapshot evidence，不宣稱已產生 legacy paired dump 或完成 CLI bridge/rollback。下一片段仍需 explicit legacy paired schema、raw＋post-baseline journal binding、B02 direct CLI bridge/forward retry/old-binary restore verification，以及 pre-paired raw recovery。新 helper/capture 仍待 Sol review。
- native Herdr activationreviewb02 Sol/high confirmed working kernel-FD／pg-spawn 限定 review；尚無 final，未重啟 agent。B02、deb/final rebuilt smokes/fullintegration/ADR/最後 Standards+Spec 與 B03–B17 保留全 scope。此輪實質 progress、無 blocker，未 commit/push/deploy。

### B01 raw／post-baseline 配對快照（2026-09-08 05:19）

- 新 `tools/cli/src/legacy-paired-snapshot.ts`：createLegacyPairedSnapshot／readLegacyPairedSnapshot，明確 kind=legacy-b01-paired，不放寬 modern paired reader。共用 strict paired 子schema與 legacy source schema（legacy-safety-snapshot.ts 現 export legacySafetySnapshotSchema），不偽造 B01 manifestChecksum。
- Creator 必須先讀取／驗證既有 raw safety descriptor/dump/兩個 artifact；以固定 Commerce pre-B02 catalog 產生 selection＋SQL prefix，確認來源最新 effective sequence 的 baseline catalogChecksum 與兩個 false flags。Provenance 在 capture 前查詢，capture 再確認同一 sequence，避免 pool max1 在 callback 再借連線造成死鎖。既有 withReleaseSnapshot 捕捉 post-baseline SQL／release history 與 exported snapshot，native dump 綁相同 DB OID/systemIdentifier/fullproperties，descriptor 綁 raw directory/checksum、baseline UUID/catalog/checksum/false flags、兩個 artifact、endpoint／兩份 dump。
- 發布前兩次重新驗證 raw safety 全鏈；COMMIT＋advisory unlock 後才 exclusive UUID reservation／rename／fsync operation root。失敗只清 own staging。Reader 重新驗證 raw dump＋source/candidate fulltrees、兩份 descriptor identity/physical endpoint、post-baseline dump bytes/hash。此為 internal helper；CLI bridge／forward journal／legacy rollback 尚未接線。
- 擴充 legacy-safety integration：真 Commerce 49 SQL 執行後轉回舊三欄 metadata shape（非聲稱保留 B01 binary），owned PG17 pool max1；原始 dump restore 49/7 且無新 metadata；baseline 後 paired dump restore 49、f|f、7。修改任一 dump reader 拒絕；pg_dump 失敗不 publish；baseline SQL verified=true 拒絕且不 publish。首輪 fixture 遺留現代 metadata 表而失敗，已在 owned fixture setup 明確移除兩張空表後修正。
- 最終新 legacy＋既有 modern snapshot 4 integration PASS `/tmp/storeweave-b02-legacy-pair-final-integration.log`；72 unit PASS `/tmp/storeweave-b02-legacy-pair-unit.log`；typecheck PASS `/tmp/storeweave-b02-legacy-pair-final-typecheck.log`；git diff --check PASS。無新 dependency/domainSQL/rootrelease 或外部寫入，未 commit/push/deploy。
- 已收 kernel FD／pg spawn Sol/high scoped PASS `/tmp/storeweave-b02-parent-fd-pg-spawn-sol-pass.txt`，非全 B02：仍建議真 PG frontend parent-death、runReleaseCli parent-death、unsafe lock inode negatives、output overflow＋held lock cleanup 的精確 coverage。SIGKILL own-private temp residue 是已知低殘餘，無未要求的 scavenger。
- 已續派 activationreviewb02（既有 wA:p1Y Sol/high YOLO）B01 recognizer／raw／paired capture／legacy SQL selection 限定唯讀 review，確認 working，待收。Next：此 review findings、explicit CLI source-inside-releases/兩dump durable bridge journal、same candidate forward retry、B02 direct legacy scratch/OID cutover＋actualoldCLI/API verify、pre-paired raw restore。B02 deb/finalnativeDocker/fullintegration/ADR/Standards+Spec，B03–B17 完整保留。此輪實質 progress，無 blocker。

### B01 bridge durable journal（2026-09-08 05:24）

- 新 `tools/cli/src/legacy-bridge-journal.ts` 共用既有 private/fsynced JSON 與 locked-root provenance helpers；create 在 raw safety capture 之後、baseline DDL 之前記錄 bridge.json，0700 UUID directory／0600 file。Strict schema 固定 catalog、非空 bounded evidence、原始 safety reference；safety phase 必須無 pair，其後 phase 必須有 pair。
- read 每次重驗 raw dump／source candidate trees，若有 pair 再驗兩份 dump 與相同原始 safety reference/catalog，拒絕不同 transition。advance 僅同 phase 或向前一步（safety→paired→migrating→migrated→activated），不允許換原始 safety／candidate；首次 attach pair 必須綁相同 raw reference，writer 回傳重新讀驗的完整 record。
- 真 PG17 existing legacy integration 覆蓋日誌 creation/0600、逐步前進、跳步與倒退拒絕、外部 journal path 拒絕、raw dump tamper 拒絕。新增另一候選 0.2.1 的真 raw/paired dump，不能 attach 到原 0.2.0 bridge journal，失敗後 phase 仍 safety。這是 journal boundary 測試，並未聲稱 phase 字串更新已執行真 migration／current switch。
- 最終 integration PASS `/tmp/storeweave-b02-legacy-journal-candidate-integration.log`（14.01 秒）；typecheck PASS `/tmp/storeweave-b02-legacy-journal-final-typecheck.log`；git diff --check PASS。前序基礎 journal PASS `/tmp/storeweave-b02-legacy-journal-final-integration.log`。
- 新檔尚未接 main.ts CLI；next 必须接 explicit B02 direct legacy upgrade、source current-inside-releases與CLI/candidate identity、raw-first durable journal／baseline／pair／same-candidate forward retry，然後 legacy rollback scratch/OID/source CLI API 及 pre-paired raw recovery。此日誌沒有改 modern upgrade journal。
- Sol/high native activationreviewb02 仍 confirmed working B01 capture review，子 review 已完成但主代理尚未 final，未重啟；新 bridge journal 需後續 integration scope review。無 dependency/domainSQL/rootrelease 改动，未 commit/push/deploy。B02/fullB03–B17 繼續，無 blocker。

### B01 capture 兩項 HIGH 修正（2026-09-08 05:30）

- 收 Sol `/tmp/storeweave-b02-legacy-capture-sol-review.txt` 兩项 HIGH：raw helper 未強制舊三欄/無新 metadata，raw history checksum 未被 paired 使用；baseline provenance 在 exported transaction 前讀且未綁完整 baseline record/每筆 migration provenance。CLI 接線因此先延後修正。
- `withLegacySafetySnapshot` 在同一 RR READONLY transaction 內要求 public.platform_migrations 精確三欄 applied_at/id/phase，且 public.platform_release_history/platform_migration_baselines 均不存在；否則在 dump 前拒絕。`withReleaseSnapshot` 的 DB callback 現提供該既有 PoolClient 第二參數；Runtime snapshot API 未改，既有只收 snapshot 的 callbacks 相容。
- `legacy-paired-snapshot.ts` 移除 transaction 外 provenance query，改用 capture 的同一 client/transaction/sequence 查完整 baseline server JSON，核對固定 catalog/source_release/checksum、兩false flags、非空 evidence/有效 accepted_at，descriptor baseline.checksum 綁整筆 record。完整 migration server JSON 投影回 id/phase/applied_at（保留 microseconds）需與 raw checksum 相同；逐筆驗 legacy_baseline_id/migration_owner/migration_id/module_id/module_version/release_id/release_version。完整 migration row checksum 原本已由 shared snapshot evidence 綁定。
- 真 PG max1 regression：baseline 後 raw capture 拒絕；applied_at +1 microsecond、source_release 錯誤、七項 migration association/provenance 欄位 NULL 均拒絕；pg_dump adapter 在 export 後修改 live baseline source_release/verified flag，還原 dump 保持原資料且 full baseline row checksum 等於 descriptor。這證明 descriptor/dump 共用 snapshot，並不聲稱攔住違反停寫契約的外部作者。
- 22 integration PASS `/tmp/storeweave-b02-legacy-capture-fixes-integration.log`（18 history＋3 modern＋1 legacy）；新增七欄 negatives 後 final legacy PASS `/tmp/storeweave-b02-legacy-provenance-final-integration.log`，typecheck PASS `/tmp/storeweave-b02-legacy-provenance-final-typecheck.log`，git diff --check PASS。完整 unit `/tmp/storeweave-b02-legacy-capture-full-unit.log` 此時已啟動，結果待下行確認。
- 已續派既有 native activationreviewb02 Sol/high 對兩HIGH修正複查（無 tests/services/writes），pending；不把未接 CLI/restore/journal 當此scope已完成。新增 baseline.checksum 必須由後續 legacy scratch verifier 從恢復DB同樣完整 JSON 重算，不能漏掉。完整 CLI bridge與 raw recovery、legacyrollback、deb/finalsmokes/fullintegration/ADR/最後審查、B03–B17 全部保留。
- 此輪 production+tests 有實質修正，無 blocker。無新dependency/domainSQL/rootrelease或外部寫入，未commit/push/deploy。

- 後續確認：完整 unit 57 files／717 PASS `/tmp/storeweave-b02-legacy-capture-full-unit.log`，session exit 0；Sol/high 複查 confirmed working。

### B01 forward CLI 接線（2026-09-08 05:38）

- `main.ts` upgrade 新 explicit --from-legacy-b01，fresh --release＋--catalog＋--evidence，durable --resume，以及 orphan raw --safety＋--checksum＋catalog/evidence。每條仍需 --external-writers-stopped；modern mode 拒絕 legacy options。B01 操作須 Commerce 且直接執行完整 B02 candidate app/cli.js，執行中 release.version／完整 tree checksum 必須與 candidate 一致；來源與候選是同 installation releases 的直接子目錄，current 必須綁 source/candidate。
- 在既有 withTransitionLock 內：驗來源→install exact candidate→停服務→raw safety capture/read驗證→輸出 raw directory/checksum→durable bridge.json BEFORE baseline DDL；raw orphan 可讀回續建日誌。safety phase 驗 physical endpoint/DB identity 與精確 old history projection，再 baseline adoption、same raw＋candidate paired capture、attach pair。paired→migrating 後 private candidate CLI migrate，migrated 後 status current/no pending、全journal重驗／physical再驗、atomic current switch、activated，最後可選restart。失敗不自動 restore/start/current switch。
- `requireUpgradeDatabase` 參數縮至實際使用的 database name/OID/systemIdentifier＋endpointChecksum，可接受 modern／legacy verified snapshot，無合成 manifest/evidence。Modern 行為不變。
- 新 durable integration `tests/integration/cli-legacy-upgrade.test.ts` 使用真 Commerce B02 bundle與PG17、49真SQL轉舊metadata形狀；B01 source executables 仍 structural fixture（不宣稱actualoldruntime）。實測無implicitmodernfallback、raw發布後bridgejournal前actual SIGKILL、orphan --safety recover、candidate SQL前exit23→migrating/currentold、samejournal resume/activated/idempotence/effectivehistory只有0.1.0與0.2.0。真部分SQL已提交後retry由先前modern e2e證明，不能把新exit23當部分SQL證據。
- 第一輪 legacy CLI scenario PASS `/tmp/storeweave-b02-legacy-cli-integration.log`；typecheck發現create/read safety回傳型別不同，改為發布後readLegacySafetySnapshot取得完整verified record，並加safety-resume binarypreflight。最終legacy＋modernCLI 2 PASS `/tmp/storeweave-b02-legacy-modern-cli-final-integration.log`；717unit PASS `/tmp/storeweave-b02-legacy-cli-full-unit.log`；typecheck PASS `/tmp/storeweave-b02-legacy-cli-final-typecheck.log`，diffcheckPASS。
- 收 B01 capture兩HIGH修正 Sol/high scoped PASS `/tmp/storeweave-b02-legacy-capture-fixes-sol-pass.txt`。已續派既有 native activationreviewb02 wA:p1Y Sol/high 審 forward CLI/journal；confirmed working，未重啟。新CLI尚待此review，不宣稱productionready。
- 下一片段須 legacy restored DB verifier（完整baseline.checksum/falseflags/provenance）＋B02 direct paired scratch/OIDcutover/retainedactualB01CLI/API驗證，並完成pre-paired raw recovery。現有 modern rollback不接受legacypair；不能用old blindrollback替代。仍需actualretainedB01 full CLI transitionprobe、legacycurrentcrashes/config/identity精確negatives、deb/finalnativeDocker/fullintegration/ADR/最後Standards+Spec、B03–B17。此輪實質progress，無blocker，未commit/push/deploy或改domainSQL/rootrelease。

### B01 restored DB／private source status 與 forward review 修正（2026-09-08 05:48）

- `verify-restored-database.ts` 新 verifyLegacyRestoredDatabase，與 modern 共用 private verifySnapshotDatabase：同一 RR READONLY 檢查 endpoint/OID/system/properties/PG17/full migration/release history/sequence，legacy 額外從 captured sequence 的 FK 讀完整 baseline JSON，檢查 id/catalog/checksum/evidence/兩falseflags 與 baseline.checksum。無第二套 DB identity／cleanup 規則。
- 真 restored DB regression：positive與wrongOID；兩flags/source_release/catalog_checksum/evidence/accepted_at+1microsecond、migration legacy_baseline_id 改動均拒絕，還原原值再通過。legacy＋modern 4 PASS `/tmp/storeweave-b02-legacy-restore-verifier-integration.log`。
- `run-release-cli.ts` 接受經驗證的 explicit B01 source，仍只執行完整privatecopy；legacy 僅允許 status，參數 migrate --status，不傳舊版不支援的 --json，禁止migrate。`verify-source-runtime.ts` 新 verifyLegacySourceRuntime：pair read→private old status→pair reread；不能以humanstatus取代exactDBverify，後續cutover須DB/status/DB包覆。
- Private old status/unit modern regression 22 PASS `/tmp/storeweave-b02-legacy-source-runtime-unit.log`。實際保留 B01 host cli＋native layout clone＋host Node 的 `/tmp/storeweave-b02-private-b01-status-probe.cjs` PASS `/tmp/storeweave-b02-private-b01-status-probe.log`：privateLegacyStatus=true、49 migrations、兩falseflags，原old/new API與history/product亦PASS。未動原release；尚非完整legacyrollback。
- 收 forward CLI Sol `/tmp/storeweave-b02-legacy-forward-sol-review.txt` HIGH orphan safety新journal證據B可配已採納A，MED raw precheck未固定search_path。已修：createLegacyPairedSnapshot必收journal evidence，同snapshot baselineEntry.evidence精確trim比對；paired schema保存baseline.evidence，bridge read/advance與legacyDBverifier都比對。B journal保留safety/null不能pair/migrate，A可等價重建。main precheck與共用withReleaseSnapshot都SET LOCAL search_path=pg_catalog，涵蓋unqualified pg_export_snapshot來源。
- 真CLI新regression A採納後B orphan拒絕/currentold/no pair，A重建走到candidate可續跑；retained DB trap.to_jsonb與trap.pg_export_snapshot同名函式（psql證明shadow有效）不影響真projection/export。2 legacy/helper PASS `/tmp/storeweave-b02-legacy-evidence-binding-integration.log`；final trap export＋modern snapshot 4 PASS `/tmp/storeweave-b02-legacy-shadow-final-integration.log`。
- 完整 unit 57/718 PASS `/tmp/storeweave-b02-legacy-restore-boundary-unit.log`；final typecheck PASS `/tmp/storeweave-b02-legacy-restore-boundary-final-typecheck.log`；diffcheckPASS。已續派 native activationreviewb02 Sol/high 限定複查evidence/search_path修正，confirmedworking；新DBverifier/privatelegacyexecutor留後續獨立scope。
- Next wiring：restore journal需明確legacy kind並仍保持modern strict；scratch restore共用existingPG17 native transaction/properties/OID流程，legacy cutover採DB/status/DB新verifiers，main explicitB02candidate rollback＋freshyes/writerack。之後actualB01 full pairedrollback/API與pre-paired raw recovery。當前modern rollback仍不接受legacypair。B02/deb/finalsmokes/fullintegration/ADR/最後review/B03–B17完整維持。此輪實質progress、無blocker，未commit/push/deploy或變domainSQL/rootrelease。

### B01 paired rollback CLI／actual retained API（2026-09-08 05:57）

- restore-journal.ts 新明確 kind legacy-b01-restore，按kind選strictlegacy reader；modern restore kind保持modern reader，不自動fallback。restoreSnapshotToScratch最後format參數預設modern、explicitlegacy-b01選legacy pair／journal；共用既有PG17superuser/scratch/properties/ACL/settings/native dump/OID/fsync流程。resumeRestoreCutover按kind選legacy DB／privateoldstatus／DB驗證，before/after cutover兩側一致。
- main rollback --to-legacy-b01 需exact executing候選B02tree/version、同installation releases直接source/candidate；resume kind必須對應explicitflag。沿用fresh --yes/--external-writers-stopped、current binding、atomic switch與可選restart；modern不能默認接受legacy pair。原始raw safety recovery仍未接。
- 真CLI regression：升級後改商品name=Candidate，pairedrollback在DBCOMMIT後/committedjournal前actualSIGKILL；日誌仍intent/currentcandidate，缺legacyflag resume拒絕，正確resume識別OID完成current→B01，releasehistory回0.1.0、商品Original、f|f。PASS `/tmp/storeweave-b02-legacy-cli-rollback-integration.log`。
- 測試可明確傳 STOREWEAVE_B01_CLI_FIXTURE 指定保留hostbundle；此時source使用真B01CLI/API＋host Node，非structural source。由 `/tmp/storeweave-b01-build-path` 傳入後完整rollback/oldstatus PASS `/tmp/storeweave-b02-actual-b01-cli-rollback.log`；新增rollback後實際啟B01API、GET /health/live=200、SIGTERM exit0，再PASS `/tmp/storeweave-b02-actual-b01-api-rollback.log`（38.98秒）。未傳fixture時的CI場景保留structuralsource，不能據此宣稱oldruntime；未實測oldworker或發布原nativeLinuxartifact。
- 收 Sol evidence/search_path複查 `/tmp/storeweave-b02-evidence-shadow-sol-review.txt`：evidence binding PASS，另HIGH指出withMigrationLock在SET LOCAL前/COMMIT後的pg_advisory_lock/unlock未qualify。主代理已同時修正兩呼叫為pg_catalog，新增retainedtrap throwing函式、實際pg_locks count1、independentbackend pg_try=false、完成後count0 regression。第一次測試從DBbarrel誤import未export內部helper而失敗，改directinternalimport後6 PASS `/tmp/storeweave-b02-advisory-shadow-final.log`。
- Modern actualCLI upgrade/rollback scenario PASS於 `/tmp/storeweave-b02-advisory-shadow-modern-rollback.log`（該整體invocation因上述testimport失敗，不能寫成全runPASS）；focused lock rerun已補正。718unit PASS `/tmp/storeweave-b02-legacy-rollback-unit.log`，finaltypecheck PASS `/tmp/storeweave-b02-actual-b01-rollback-typecheck.log`，diffcheckPASS。
- 已續派 native activationreviewb02 Sol/high 審advisoryHIGH修正＋legacypairedrollback/DBverifier/privatelegacyexecutor完整限定鏈，confirmedworking，尚未final。Next pre-paired raw recovery可沿既有scratch/OID流程加入explicitrawkind與rawDB形狀/historychecksum/oldstatus verifier，不能fake成modernpair；另legacy升級currentcrashes/mismatch精確negatives、nativeinterop精確cases/deb/finalbuildsmokes/fullintegration/ADR/最後Standards+Spec與B03–B17完整保留。此輪實質progress、無blocker，未commit/push/deploy/domainSQL/rootrelease變更。

### B01 raw recovery CLI 與舊 status HIGH 修正（2026-09-08 06:08）

- DB 抽出 readLegacySafetyHistory 共用raw capture／restore：舊三欄、無兩張B02metadata、UTC/ISO serverJSON microsecond checksum。verifyLegacySafetyDatabase與modern/paired共用physical/historytransactioncleanup，raw只比rawschema/history，不偽造release history。verifyLegacySafetyRuntime使用私有B01status並重驗rawdescriptor/artifacts/dump。
- restore journal新明確kind legacy-b01-safety-restore，reader／scratch format／resume verifier 分支各自strict。main rollback --safety <dir> --checksum <sha> --to-legacy-b01，仍需exactcandidate及installation source/current、freshyes/writerack；resume依rawjournalkind選讀，但不能缺explicitlegacyflag。沿用同一PG17scratch/properties/OID/fsync/cutover/保留DB流程。
- 真CLI raw scenario：已rawcapture→baselineadoption→paired pg_dump故意失敗（沒有publishedpair），改商品資料，rawrollback在DBcommit後/committedjournal前actualSIGKILL，resume後49rows/Original/兩B02metadata不存在/三欄。與paired模式2 PASS `/tmp/storeweave-b02-raw-rollback-cli-integration.log`。raw verifier＋modern snapshot4 PASS `/tmp/storeweave-b02-raw-restore-verifier-integration.log`，含microsecond／兩metadata表／extra欄位拒絕。
- Sol `/tmp/storeweave-b02-legacy-status-sol-review.txt` 確認advisorylockHIGH closed，另HIGH指出old migrate --status會CREATE IF NOT EXISTS且結果被忽略，savedtrap可能產生空shadow ledger/49pending。已修runReleaseCli：僅legacy status的URL最後append -c search_path=public（保留既有options），stripVTControlCharacters後解析固定B01已套用/待套用格式，pending段必須恰為（無），否則拒絕。不再宣稱oldstatus為SQLread-only，僅status-only；禁止legacy migrate仍保留。
- Durabletest以explicit STOREWEAVE_B01_CLI_FIXTURE讀保留B01hostcli與同目錄api，runtime用hostNode。兩實際B01 raw/paired recovery PASS `/tmp/storeweave-b02-actual-b01-status-fixed-recovery.log`（44.62/24.71秒）：actualoldCLI status與APIhealth/exit0，savedtrap未產生trap.platform_migrations；exit0但pending輸出fixture在cutover前拒絕/currentcandidate/同OID。先前僅APIhealth通過的證據不能替代這一修正後證據。
- 718unit PASS `/tmp/storeweave-b02-raw-status-unit-final.log`；typecheck PASS `/tmp/storeweave-b02-raw-status-typecheck-final.log`；diffcheckPASS。首輪fullunit只因新增--safety後錯誤訊息期待未更新而1fail，已更新tests/unit/cli-upgrade.test.ts並全數重跑綠；未改既有approval/入參拒絕語義。
- 已續派native activationreviewb02 Sol/high 審statusHIGH修正＋rawrecovery完整限定鏈，待收；沒有重啟agent。此輪local production/tests實質progress，無blocker；無dependency/domainSQL/rootrelease或外部寫入，未commit/push/deploy。
- B01 forward/paired/raw主要路徑已有actualCLI/API證據，但仍需Sol收斂、更多legacy currentcrash/candidate/statusrestart精確negative；B02 native/deb parity、最終重建native/Dockersmokes、fullintegration/ADR/docs與最終Standards+Spec仍待。B03–B17未縮減，goal保持active。

### B01 status/raw Sol 收斂與 Debian 包裝盤點（2026-09-08 06:18）

- native activationreviewb02 Sol/high 回覆：legacy-status HIGH closed，raw recovery 在審查範圍通過；另 LOW 指出 duplicate URL options 會因 get() 只取第一值改變已接受語義。共用 parsePgUrl 已拒絕 getAll(options).length > 1，新增 native execution 前拒絕 regression。42 tests PASS `/tmp/storeweave-b02-duplicate-options-unit.log`，git diff --check PASS；已回派同一 reviewer 核對這一行與測試，尚待最後回覆。
- Debian 盤點：build-release.sh 目前 payload 直接 unpack 到 live releases，postinst ln-sfn current，繞過 transition lock／CLI migration；尚未修改包裝。preinst flock 單獨不足，因 unpack 前已釋放。新增同 tab 下方 Herdr pane wA:p10，debdesignb02 Sol/high YOLO/no-alt-screen，read-only 設計最小可重試包裝方案，confirmed working。需兼顧 dpkg configure retry、package upgrade/remove，不可只加假鎖。主代理保有高風險實作 ownership。
- 此輪無依賴／domainSQL／preserved root release／外部寫入，未 commit/push/deploy。B02 step2、完整 B03–B17 保持 active。

### Legacy current rename 中斷回復（2026-09-08 06:22）

- tests/integration/cli-legacy-upgrade.test.ts 在既有 real CLI paired 情境新增 current rename 前／後 actual SIGKILL，兩次都檢查 bridge phase=migrated，current 分別保持 source／已指 candidate；同 journal resume 到 activated，再 resume 不重複 release history。raw 情境亦回歸。
- 指定保留實際 B01 host CLI/API，2 PASS `/tmp/storeweave-b02-legacy-current-crashes-final.log`（paired49.13s/raw22.15s）。首輪錯用保留build的 app/cli.js 路徑，兩測試 ENOENT，修正為 cli.js 後上述重跑通過。typecheck PASS `/tmp/storeweave-b02-current-crash-typecheck.log`，diffcheck PASS。native activationreviewb02 已收 duplicate-options LOW scoped PASS，正核對新增 crash hook/loop（限定 test-only）。
- debdesignb02 仍 working，已確認 unpack 應只持有獨立 media，不持有 live releases/current；尚待確切 package paths／fresh native install／CLI upgrade／configure retry／remove 契約。未改 build-release.sh 或 install-native.sh，沒有外部寫入。完整 goal active。

### Debian 安裝媒體邊界（2026-09-08 06:27）

- scripts/build-release.sh 的 .deb 改為只含 /usr/lib/storeweave-release-media/NAME/VERSION 下原生 tarball／README；移除 live /opt releases、current、CLI symlink、設定、unit payload 及 postinst。dpkg不啟用程式；fresh由明確解壓後native installer，既有升級仍走原CLI archive流程，B01仍directcandidate explicitbridge。沒有新增CLI介面或installer框架。
- preinst檢查現有同名套件是否持有已知livepaths，存在則在unpack前拒絕，避免dpkg刪舊livefiles；文件說明此類部署用tarball流程、不可藉remove舊套件繞過。只交付媒體，移除不必要postgresql-client dependency，部署者仍需依操作需求準備工具。docs/deployment-native.md已替换過時postinst描述，提供fresh實際命令／media更新移除語義。
- 新 tests/integration/deb-media.test.ts 擷取實際packaging block，使用小tarfixture、隔離node:22 Debian容器，真dpkg unpack/configure/reconfigure/新版update/purge，檢查livepathinode/mode/link/hash原樣；模擬legacyownedlivepackage再更新拒絕且舊files保留。PASS `/tmp/storeweave-b02-deb-media-r3.log`。首輪TS template插值錯誤、第二輪arm64容器拒amd64package；修正shell變數及僅測試容器add-architecture後通過，未在主機安裝套件。
- typecheck PASS `/tmp/storeweave-b02-deb-typecheck.log`，bash syntax／diffcheckPASS。此為真dpkg生命週期但tar內容structuralfixture，完整最終native/deb artifacts仍待重建。debdesignb02 Sol/high 已改為審查目前變更，confirmedworking；尚不可宣稱fullPASS。activationreviewb02 currentcrash test scopedPASS已收。
- 無外部寫入／新dependency／domainSQL／preserved rootrelease變更。B02 step2與完整B03–B17繼續active。NEXT收debdesignb02 boundedreview，修finding後進finalnative/Docker/fullintegration/docs/ADR/雙軸完整審查。

### 最終整合驗證與 Debian 審查修正（2026-09-08 06:33）

- 完整 integration 77 files／597 PASS `/tmp/storeweave-b02-final-integration-r1.log`，explicit保留B01 cli.js，因此legacy兩案例含實際舊CLI/API。此run完成後又改debidentity，該新行為獨立PASS `/tmp/storeweave-b02-deb-media-coexist.log`。最新unit57files／719 PASS `/tmp/storeweave-b02-final-unit.log`；typecheck PASS `/tmp/storeweave-b02-final-typecheck.log`；diffcheckPASS。
- debdesignb02 Sol指出同名套件造成legacy無法安裝媒體HIGH、user-owned extraction再sudoHIGH、preinst未dispatch actionMEDIUM。採獨立 NAME-release-media package與artifactfilename、完全刪preinst；新舊套件共存，不需ownershipmigration。docs兩個fresh例子均sudo mktemp/root解壓；ADR同步。新真dpkg test先装legacy再media/update/purge，保留livepaths、舊media移除、archivecmp、packagefilelist白名單，PASS。上段preinst方案已superseded，不再適用。debdesignb02正複查此修正。
- 新增 proposed docs/adr/0037-release-selection-and-history.md與index，尚未宣稱B02accepted；activationreviewb02 正審factual claims／lock windows／adoption限制。待收修正。
- 新native Herdr pane wA:p21 nativesmokeb02，Terra/high YOLO/no-alt-screen，execute-only/noedits。Base原生PASS `/tmp/storeweave-b02-final-native-base.log`，tar `/tmp/storeweave-b02-final-native-base.HI4eDL/artifacts-release/storeweave-0.2.0-test27.tar.gz`；Commerce仍跑 `/tmp/storeweave-b02-final-native-commerce.log`，artifact `/tmp/storeweave-b02-final-native-commerce.yIJKiq/artifacts-release/commerce-0.2.0-test27.tar.gz`。使用Bash5、全新tempdirs，preservedroot未覆寫；host無dpkgdeb故這些nativebuild未產deb。
- 已續派同Terra在native後執行Base/Commerce獨立Docker smoke，uniqueproject/image與33273/33274ports；log `/tmp/storeweave-b02-final-docker-base.log`、`/tmp/storeweave-b02-final-docker-commerce.log`，尚未回報。primary不重啟或重跑。六個dbcli容器／外部state保持。
- NEXT收兩Sol review及Terra smokes，仍需fullrealdeb artifact验证、Admin必要checks、最後Standards+Spec vs B02baseline以及B03–B17。無blocker，完整goal active。

### Native／Docker／真實 deb 與採納前 property gate（2026-09-08 06:38）

- Terra nativesmokeb02 已完成Base/Commerce native及Docker四smokes全部PASS；Docker Commerce62checks，Base依log，所有ownprojectcontainers/networks/volumes已清理、portsfree，smokeimages保留；rootdist/release未用。各log `/tmp/storeweave-b02-final-{native,docker}-{base,commerce}.log`。Terra現在另跑finalAdmin tests/typecheck `/tmp/storeweave-b02-final-admin.log`、`/tmp/storeweave-b02-final-admin-typecheck.log`，待收。
- 真實兩個native tarball包成獨立release-media deb，在ownedlinux/amd64 Debian容器dpkg install、root私有extract/nativeinstall、直接正式版本目錄完整validator、purge媒體後CLI/env仍在，兩release成功。log `/tmp/storeweave-b02-real-deb-install-final.log`，產物/driver根目錄指標 `/tmp/storeweave-b02-real-deb-path`。首輪validator用current symlink被正確拒絕，改directreleases/version後重跑PASS；沒有hostpackage安裝。這些tar先於下述B01preflight一行邏輯新增。
- debdesignb02 codePASS、docsMEDIUM缺B01完整命令／LOW extractioncleanup。docs補完整候選CLI --from-legacy-b01、samearchive、catalog/evidence/writerack/no-restart與journalresume；成功後清除rootprivateextract、失敗保留。兩fresh例子補cleanup。該Sol正做docsclosure。
- activationreviewb02 ADR審查另HIGH：B01baseline前僅physical/history比較，完整property drift到pairedcapture才拒絕，可能已改metadata。main safety-phase既有RRreadonly preflight新增readSnapshotDatabase全摘要比對safety，先拒絕再DDL；不宣稱阻止違反停寫前提的外部race。Actual B01 test在rawcapture後改DBcomment，拒絕且無兩metadata/仍三欄，還原comment後完整paired/raw流程2PASS `/tmp/storeweave-b02-prebaseline-properties.log`。新增拒絕journal使test精確選phase=migrating journal。typecheckPASS `/tmp/storeweave-b02-prebaseline-typecheck.log`、diffcheckPASS。
- ADR修proposed實作仍進行、prepare鎖釋放→setup鎖外→finalizer重鎖CAS、失敗無autoDBrollback、wholeDBrestore與quarantine後寫入、raw無metadata、PG17superuser及roles/extensions/tablespaces/停寫前提、forward-onlydowngraderefusal。Sol正複查HIGH與ADR，未收final。
- 先前77/597fullintegration、719unit仍作previousfullrun證據，此輪新增productionpreflight有上述reallegacy2PASS+typecheck。剩最後review收斂、Admin、finalStandards+Spec vs B02baseline及完整B03–B17；不得prematureB02accepted或goalcomplete。此輪實質progress，無blocker／外部write。

### B02 進入完整獨立雙軸審查（2026-09-08 06:42）

- activationreviewb02 收 ADR／prebaseline property gate scopedPASS，無剩餘finding。debdesignb02 最後兩個docs修正已完成：PG client用途含upgrade，env統一0640 root:commerce。Admin26/314與typecheckadmin均PASS，Terra無sourceedits。
- Primary補完整Base選取/build env說明、B01 paired/raw rollback及journalresume命令、wholeDB/quarantine語義；不改production。B02 visibleplan更新step2候選實作done、step3驗證文件done、step4獨立review in-progress；B02整體仍in-progress，finding會回開。
- 以起始dirty快照建立 /tmp/storeweave-b02-final-review.diff 與 /tmp/storeweave-b02-final-review-files.txt，134source/doc/testpaths。原HEAD同1f4470d，不能gitdiffHEAD把priorTickets/B01誤算B02。生成graft maps明確排除（不是本次sourcechanges）；先前681粗list已被134更新取代。兩個最後docs-only更新在currentsource，可對照。
- 已結束idle nativesmokeb02及debdesignb02（ctrl+d），保留panes重啟全新獨立Sol/high YOLO/no-alt-screen：b02standards wA:p21、b02spec wA:p10。兩者confirmedworking；read-only/noedits/noextraagents，分別Standards含完整smellheuristics與安全正確性、Spec限B02卡／0009相關要求，不把B03–B17待做當B02缺失。activationreviewb02 wA:p1Y仍idle available。
- preserved 2461files SHA全部未變 `/tmp/storeweave-b02-final-preserved-release-check.json` changed=[]。六dbcli IDs仍在，其他existingcontainers亦保留（包含停止的舊storeweave等，不清理）。diffcheckPASS。
- NEXT等待新Sol兩軸結果（review可能需數分鐘，按liveget/read/wait，不重啟）；修實際finding並適當tests，才B02accepted/解鎖B03。完整目標81–90+B00–B17未縮减，無blocker，active。

### Commerce demo 明確重跑驗證（2026-09-08 06:47）

- 等待完整雙軸審查時補齊既有 release-artifacts.test.ts 的 Commerce --demo 兩次真builtCLI執行，檢查商品／三帳號、23個庫存列（24商品含一個明確stock0展示）、一筆VIPreward完整列，再跑一次stock/reward/count完全相同。首輪test錯假設每商品皆有stockrow，依seed的WD-POT-07 stock0修正；第二輪揭露真實reward缺失。
- scripts/seeds/commerce.ts 原本呼叫不存在的 commerce.loyalty.adjustReward，emptycatch吞掉後印成功。已改為既有註冊的 adjustRewards，一行修正，不加SQL/新command；透過原idempotencykey避免重複金額。兩個獨立reviewer已通知此唯一新增productiondelta。
- 新focused三案例PASS `/tmp/storeweave-b02-demo-repeat-r3.log`（migrationlessBase、Base四產物/seed/生命周期、Commerce四產物/default+demo兩次/oldbaseline/生命周期）；typecheckPASS `/tmp/storeweave-b02-demo-fix-typecheck.log`、diffcheckPASS。先前全integration/719unit/smokes仍是before這一seed typo fix的廣泛證據，最新產物由上述test重建執行。
- b02standards wA:p21、b02spec wA:p10 仍confirmedworking，無restart。standardswait45s逾時後已get重新確認working，不是停止/阻塞。activationreviewb02 idle。NEXT收兩reviewfinal再修findings；不得用demo證據替代完整B02雙軸審查。無外部writes／rootrelease變更，fullgoalactive。

### 最新候選產物（2026-09-08 06:50）

- 含最新B01property gate及Demo typo修正的Base/Commerce原生release 0.2.0-test48已重新build，唯一新root /tmp/storeweave-b02-current-release.xFWJAD，指標 /tmp/storeweave-b02-current-release-path。buildlog /tmp/storeweave-b02-current-release-build.log exit0；兩完整stage在ownedlinux/amd64 Debian容器由所附runtime/validator驗證PASS /tmp/storeweave-b02-current-release-validate.log。沒有hostdpkg，因此此build沒有deb；之前realdeb lifecycle及native/Docker smoke證據仍保留，不能稱test48做過全smoke。
- b02standards與b02spec兩完整review confirmedworking，約8分鐘，還未final；standards/spec wait45s timeout後已get確認live，沒有restart。沒有新production變更。NEXT繼續收final findings／修正，B02不得先accepted，goalactive無blocker。

### 完整雙軸 findings 與前兩項修正（2026-09-08 06:56）

- b02spec full verdict NEEDS WORK：1 MEDIUM，Demo seed catchall吞失敗，shipping/promotions/coupons/stock/rewards/points/articles可缺資料卻exit0；其他B02 checklist匹配，B03–B17排除。b02standards full NEEDS WORK：HIGH Base staff users:write可createUser admin（違ADR0012）；MEDIUM seed monetarycatchall；MEDIUM startServices catch廣泛stopServices會殺本次未啟動、原已在跑API。其餘未發現actionable concurrency/persistentdata violation。
- 已刪BASE_ROLES staff users:write，不新增rolehierarchy；release-roles新增實際createUser admin以staffActor呼叫→FORBIDDEN、DB無該email。Commerce roles未動。
- Demo所有catchall改直接傳遞失敗（保留原blockscope以小diff移除catch）；唯accountService.createAccount僅忽略typed PlatformError CONFLICT（duplicateaccount）。刪除不再使用sql/randomUUID imports。command冪等keys保留。failclosed首次暴露coupon舊kind/perCustomerOnce非法；依既有DTO移除derivedkind、改perCustomerLimit1/null。未改domainSQL/commandAPI。
- release-artifacts新完整Demo驗證：shipping4/promotions4/coupons3/tiers4/points1/articles10全published、商品24/帳號3/stock23/reward1，兩次全列與counts相同；先以ownedDBconstraint故意拒絕shipping insert，builtseed必須exit1，再移除fixtureconstraint成功續跑。7 PASS兩files `/tmp/storeweave-b02-audit-fixes-r2.log`；typecheckPASS `/tmp/storeweave-b02-audit-fixes-typecheck.log`；diffcheckPASS。r1也7PASS但未加完整集合/forcedfailure，r2為最新。
- 已續派 b02spec審seed完整修正、b02standards審role+seed修正；startup preservation MEDIUM明確尚未修，不可close。兩同agent待收。
- NEXT primary修 tools/cli/src/service.ts startServices failure只清理本次新啟動PID/systemdunits，重用stop邏輯，新增preexistingAPI+missingworker regression保留API/PID；現有同次啟動API+missingworker仍要cleanup。檢查所有callers/stopServices，systemd亦不可廣泛stop原服務。可考慮sharedprivate stopPidServices(stopping{name,pid}[],timeout)重用既有stop等待/changedPID保護；start記actualchildpid而非僅name；systemd先記inactiveunits再start，失敗只停這些units。設計尚未實作，productionservice目前未改。
- B02候選step2因auditfindings回開，fullgoalactive，沒有外部writes/rootrelease改動。test48 artifacts先於這次role/seed修正，最終需適當重建驗證。

### Startup cleanup ownership 修正（2026-09-08 07:01）

- tools/cli/src/service.ts PID start先await child spawn事件，記錄本次新child的{name,pid}再寫pidfile，失敗只對該list呼叫共用private stopPidServices；既有API/PID不動。原explicitstop仍收所有services，保留等待exit／timeout／changedPID檔保護／restart檢查。
- systemd先記inactive/failed units，start仍啟動原要求services，失敗只stop該subset，保留原active／activatingunits。未引入manager abstraction。新增實際PID preexistingAPI+missingworker保留、mocksystemd僅stopworker回歸，原sameinvocationAPI清理回歸仍通過；9PASS `/tmp/storeweave-b02-startup-ownership.log`，typecheckPASS `/tmp/storeweave-b02-startup-ownership-typecheck.log`。
- b02standards已確認Base staff與seed前兩fix scopedPASS；現在review startup最後MEDIUM，尚待final。b02spec仍在seed完整closure review，約4min；不得重啟。
- 最新fullunit57/721 PASS `/tmp/storeweave-b02-audit-final-unit.log`；完整integration含actualB01仍running，exec session24325，log `/tmp/storeweave-b02-audit-final-integration.log`，尚未final。過程有pg concurrent-query deprecationwarning，未見failure；不能當complete。docs更新onlynewstartupcleanup語義，diffcheckPASS。
- 結束idle activationreviewb02，保留pane wA:p1Y開全新 b02finalnative Terra/high YOLO/no-alt-screen，execution-only/noedits。已派Base/Commerce native test59全新outputs/ports33275/33276，logs `/tmp/storeweave-b02-audit-native-base.log`、`/tmp/storeweave-b02-audit-native-commerce.log`，待收artifactpaths；不得rootdist/release/globalcleanup。選擇性追加ownedPG demo兩次，已有focusedcoverage所以先完成native。
- NEXT收fullintegration session24325、兩Sol closure與Terra native。如果findingclosed/requiredchecks pass，再B02accepted/documentbaseline+解鎖B03；完整B03–B17保持。無blocker/外部write。

### Spec closure／systemd unknown state（2026-09-08 07:04）

- b02spec full Spec findings已全部closed：最新seed failclosed/DTO/fullstate/forcedfailure修正PASS。無B02 Spec finding；standards前role/seed已closed。
- b02standards指出startup剩MEDIUM：statusServices舊catch把is-active沒有stdout的queryfailure當inactive，仍可能cleanup本來activeunit。已修sharedstatusread：非零只接受exit3且stdout明確inactive/failed，其他unknown；start beforestate有unknown/empty/wrong-manager則在任何start/stop前拒絕。新增status1+empty及status1+inactive兩個failure tests，正常inactive改以status3throw模擬。11PASS `/tmp/storeweave-b02-systemd-state.log`，typecheckPASS `/tmp/storeweave-b02-systemd-state-typecheck.log`。已回派同Standards reviewer finalclosure，待收。
- systemctl exit semantics核对Debian官方manpage https://manpages.debian.org/bookworm/systemd/systemctl.1.en.html ，LSB3為notactive；不能把任意非零當inactive。這裡是更嚴格拒絕，不放寬未知狀態。
- 最新fullintegration77/598 PASS `/tmp/storeweave-b02-audit-final-integration.log`（180.83s，含actualB01兩案例；warning為pg並行querydeprecation非failure）；fullunit57/721先前PASS。systemd最後guard在fullrun中途新增，針對差異的11test+typecheck是最新證據；沒有新domainSQL。
- Terra b02finalnative仍working：Base test59 nativePASS10assertions，root .../T/storeweave-native-smoke.94MCOe/release；Commerce正在跑 `/tmp/storeweave-b02-audit-native-commerce.log`。其Basebuild先於最新systemdguard，最后artifact需核對／必要重建，不能默認test59含guard。Spec/Standardsfinalclosure後才最後定版。
- NEXT收b02standards closure及b02finalnative結果，核對latestartifacts；B02仍in-progress，完整goalactive無blocker。所有審查使用同活agent未重啟，沒有外部writes。
