# B00 Queue 比較與重跑方法

狀態：B00 實測與獨立 Sol Standards／Spec 複審均完成。選型草案見 [ADR 0035](../../adr/0035-retain-postgres-queue-for-modular-base.md)。官方版本與 API 來源見 [研究筆記](pg-boss-research.md)，完整機器結果見 [queue-probes.json](queue-probes.json)。

## 重跑

在 repo 根目錄，以已安裝本專案依賴、可用 Docker 的 Node 22.17.1 執行：

```sh
npm ci --prefix scripts/poc/base-b00 --ignore-scripts --no-audit --no-fund
pnpm exec tsc -p scripts/poc/base-b00/tsconfig.json
pnpm exec tsx scripts/poc/base-b00/run.ts /tmp/storeweave-b00-queue-probes.json
```

獨立 package／lockfile 位於 `scripts/poc/base-b00`，不屬於 pnpm workspace；未改根 manifest、lock 或 runtime。既有 Database／JobQueue／RecurringScheduler 直接載入原始碼，未複製另一份 implementation。PG17 Testcontainer 只由本程式建立及清理；不接受商家 DB URL。child worker 在 committed claim 後被實際 SIGKILL；lease／heartbeat 時間透過自己的測試列老化，避免等待正式預設 timeout。

程式 exit 0 代表 **14 個 characterization 探針完成且觀察符合斷言**，不代表所有 Base 目標都已滿足。結果的 `unmetTargets` 明列功能缺口。每套 Queue 比較同一組七项契約問題，直接操作各自原生 Interface；未先實作一套掩蓋差異的 production adapter。

初始化失敗清理的 regression 可執行 `pnpm exec tsx scripts/poc/base-b00/run.ts --fail-setup`：預期 exit 1、PostgreSQL `42883`（刻意呼叫不存在的函式），並在 `finally` 關閉 pool／移除自己的 container。主代理已驗證此錯誤路徑與正常 14 probes 的清理；此 flag 只屬於隔離 PoC，不是 production 設定。Immediate-claim fixtures 明定過去的 runAt，避免 Node／PG 毫秒時差造成偶發撲空。

套件固定為 pg-boss 12.30.0／前版 12.29.0；實測 Node 22.17.1、PostgreSQL 17.11。`postgres:17-alpine` 是浮動測試 image，重跑時實際 server version 會寫入結果；不能把這次證據擴張為所有 17.x 已認證。獨立 lock 的 22 個套件條目含兩版 pg-boss；授權為 MIT、ISC 或 `(MIT OR CC0-1.0)`，解析版本、integrity 和 license 均記錄在 JSON。這份圖僅用於 PoC，production 仍用既有 `pg`／Drizzle 解析版本。

## 相同契約下的實測

| 契約 | 既有 JobQueue | pg-boss 12.30.0 | 後續成本 |
| --- | --- | --- | --- |
| Drizzle rollback enqueue | domain row 與 job 同回滾；commit 可見 | `fromDrizzle(tx, sql)` 使用本 repo Drizzle，結果相同 | 兩套都可保留原子性；Extension 本來獨立交易，不能宣稱跨 SDK KV 原子性 |
| Dedupe identity | 四個 pool 連線競爭後一列，但每次回傳不同 UUID；completed row 持續去重 | exclusive queue 一列，三個 conflict 回傳 null；pre-active upsert 可取得 id，但 completed 後可新建 | 既有只需修 conflict 回傳；pg-boss 要補全狀態 identity／去重契約；兩套都需 retention horizon |
| Running replacement | 同 id 即刻重排，B 可在 A 尚未結束時認領；不同 worker id 的舊 complete 被擋 | exclusive active job 的 update／upsert 都不替換，不會保存新 payload | 兩套都需定義並保存 deferred occurrence；不能把「拒絕替換」算作功能完成 |
| Crash／lease | SIGKILL 後可 reclaim；maxAttempts=1 仍可第二次 claim；相同 worker id 不能分辨 generation | SIGKILL 後 supervise 可重試；touch 保活、失去 heartbeat 與重複逾時會耗盡；complete 無 owner token | 既有需 heartbeat、fencing、crash attempts；pg-boss 仍需 StoreWeave fencing，不能只信 job id |
| DLQ retry | 保留 id／payload／dedupe、清 attempts；pending/completed 再重送拒絕 | redrive 新 id；direct retry 保留 id 但增加 retry limit／不清 retry count | 原生 direct retry 與 redrive 都不能直接等同現有 retryDead；映射需明確錯誤／狀態／identity |
| Timezone／DST | everyMs 以 UTC epoch 切片；Taipei 午夜實際 row 是 UTC 午夜；跳過兩日 | Taipei 午夜到期、晚五分鐘不補；fall repeated 01:30 兩次皆到期；spring 03:30 不補 02:30；同分鐘兩次 cron 只一筆 forward，實際送至目標 queue | 兩套都需明定 misfire/pause/overlap。既有需成熟 cron 計算；pg-boss 原生亦不提供完整指定策略 |
| Schema upgrade | 實際 platform 0001→0002，pending/running/dead identity/payload/attempt/error 保留，重跑 no-op；這兩版沒有 Queue table conversion | 39→40→39→40；created/active/retry/failed/completed、DLQ provenance 與 partitioned queue 的完整列保留；4 個 BAM 命令完成、drift ok；回復後舊版可完成，升級後可完成與重送 DLQ | pg-boss 維護套件 schema 較完整；現有 B02 必須補 history/checksum/order，B04 再測實際新 Queue migration |

排程的固定時鐘部分呼叫 **pinned pg-boss 私有 Timekeeper**，因公開 Interface 沒有 clock injection；這是 PoC 的白箱測試，不是可供 production 使用的 Adapter。驗證到 queue forward，不宣稱已驗證 StoreWeave 的完整 cron 管控、所有 DST 規則或多主機時鐘偏差。

## 決策與維護負擔

保留現有 Queue。pg-boss 的 heartbeat、重試、維運與 schema 管理確有價值；本次實测沒有發現 Node／PG 不相容，因此不以相容性否決它。選型依據是 **既有公開契約下的總維護負擔**：

- 兩條路都要處理 occurrence fencing、running replacement 的 deferred payload、外部副作用冪等、payload version，以及完整 scheduler policies。
- 既有路線在 `jobs.ts`、worker／recurring、platform migrations 與同一組 integration tests 補齊；原有 persisted id、SDK identity、DLQ URL、Outbox `evt:<eventId>:<subscriberId>` 不需要轉換。
- pg-boss 路線除上述共通工作，另需 attempt/state/error 翻譯、跨 queue 的全狀態 dedupe 協議、運行中工作轉換、舊新 dispatcher cutover、原生 upgrade 與 StoreWeave migration 的協調。原生 direct retry 已實測保留 id，因此不把 public-id ↔ backend-id mapping 算成必然成本；選 redrive 時才需對映或替代該路徑。即使省去對映，retry reset 與既有 global dedupe 的語意仍不能只用 send/fetch wrapper 解決。
- 保留既有路線的代價是自行維護 lease SQL、監控與清理，不能省略壓力／故障測試。B04 若不能通過相同契約，重開選型；不先承諾工期或按套件功能數推算節省時間。

## Sol 分析納入的風險

分析依 `jobs/src/jobs.ts`、`kernel/src/{worker,recurring,event-delivery,extension-host}.ts`、`db/src/migrator.ts` 與原 integration tests。主代理已將以下內容分配到後續卡：

- B02：migration advisory lock 必須綁同一 DB connection；現況透過 pool 的 session lock 不足以證明互斥。補 checksum、未知歷史與順序驗證，保留停用模組 metadata。
- B04：dedupe 回傳 phantom id、replacement 重疊、每次 claim fencing、長任務 heartbeat、crash attempts 上限與 affected-row telemetry。
- B04：Outbox relay exception 只回滾 batch，未接 `markFailed`；移除 subscriber 的已排 delivery 現況 log 後完成。必須有 durable 訂閱變更／隔離及重送政策，不再靜默遺失。
- B04／B05：payload schema/version、timeout/abort、取消、保留期、去重 horizon、排程失誤及重疊策略；bounded drain 與 shutdown 診斷。

這些是已存在的風險與本次實測結果；B00 沒有偷偷修 production，也不能宣稱已修復。
