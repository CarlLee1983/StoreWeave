# B01–B04 可執行派工契約

這四張卡具體化 [Base 計畫](../../base-implementation-plan.md)；不另建相依來源。B00 結案前不可開始 production 實作。每包由主代理擁有共用接線與高風險 implementation，先取 Sol/high 分析，整合後再由未參與實作的 Sol/high reviewer 審查。一次只推進一個 implementation 切片；純文件／測試工具可在明確 ownership 後交 Terra/high。

共同相容基準是 [inventory](compatibility-inventory.md)。新 owner 不代表新公開 id；保留 HTTP verb/path、descriptor id/payload、SDK、config／CLI 的可觀察語意。以下測試檔名是派工目標，尚未建立；不能將測試計畫當作 PASS。

## B01 — 先交付可驗證模組圖

**檔案 ownership：** `packages/platform/kernel/src/module.ts`、runtime 的 registration 前置、contracts、`packages/platform/bundle/src/modules.ts`、現有 commerce module declarations；新增 module-graph 純驗證與 `tests/architecture/module-graph.test.ts`。如需新檔，只放 cohesive graph validation；不建立通用 service locator。Extension SDK 原有受限能力不擴成 raw DB access。

**行為：** 模組有穩定 id／semver／base version range、required／optional dependencies、能力及資料／migration ownership。先驗證整個圖再建立 DB／啟動 handler；重名、缺 required dependency、cycle、不相容版本、重複能力／migration owner 要回傳可定位的 validation error。optional 缺席合法，存在時仍驗證版本。不變更既有模組名稱所形成的 event subscriber id。

**兩個 consumer：** 現有 commerce graph 與測試用的非商務活動報名模組。後者有自己的 migration、command/query/event，透過明確 constructor injection 使用公開操作；實際註冊並可在小型 DB integration 中執行，不能只回傳空物件。資料 ownership 驗證針對宣告與受控 Interface；trusted Node module 不是惡意程式 sandbox，不宣稱 TypeScript 能禁止任意 SQL。

**驗收／命令：** 純 graph tests 覆蓋亂序輸入得到相同有效順序、必需／可選相依、版本、cycle、重名、migration owner 及能力碰撞。integration 驗證兩個 consumer 的公開操作與 transaction rollback，未取得 capability 的呼叫遭拒。執行新增 focused tests、既有 architecture tests、`pnpm typecheck`、`pnpm test`，以及所觸及 command/event flow regression。

**移轉／回復：** 在同一片更新所有既有 module declarations；公開 id 不做 rename，無需永久 dual registration。保留 migration id／SQL，這包不執行 schema 轉換。任何 SDK 變更須在本卡補確切相容與移除条件後再實作。

## B02 — 同一份 release 選取模組、設定與資料

**檔案 ownership：** bundle bootstrap／modules、config schema／loaders、kernel runtime、db migrator／migration types、API／worker／CLI entrypoints、seed、build/release scripts、部署樣例。根 manifest／lock／TS／CI 一律主代理。具體驗證放 `tests/integration/base-release.test.ts`、`migration-history.test.ts` 及必要 CLI tests。

**行為：** 版本化 release definition 是 API／worker／CLI／seed／build 的唯一選取來源。乾淨 base-only release 不 import、註冊、排程 commerce，也不要求 currency／商務 provider config／商務 roles。新 base DB 只有選定基礎與網站模組表；commerce release 保留所有既有流程。模組 seed 可重跑，必要初始化與示範資料分開。

**歷史：** migration id／checksum／順序以 owner 管理，session/advisory lock 綁單一 connection 或交易；未知歷史、重複 id、checksum drift、錯序拒絕執行。既有 migration SQL 不重寫；對舊記錄一次性建立可驗證 checksum 基準。停用模組只保留 readonly history metadata，不 import runtime／跑其 migration；重新啟用先驗證保存資料與版本。移除前拒絕仍被依賴或有待處理工作，永不自動 DROP TABLE。

**驗收／命令：** 真 PG 上 base-only／commerce 各自 migrate、bootstrap、seed 重跑；檢查表名、有效 module graph、已註冊 handlers 與 emitted build graph。兩個連線同時 migrate 只套用一次；中途 failure、unknown history、checksum drift、disable/re-enable 都有 integration。初始化失敗逆序 cleanup，shutdown 有限時 drain。執行 focused integration、`pnpm typecheck`、`pnpm test`、完整 integration、兩種 release build／隔離 smoke；有 Admin build 接線時加 Admin checks。

**回復：** 保存原 release 與 DB snapshot；新 metadata 的 expand migration 要保留舊 deployment 可啟動條件。實測 migration 中斷重跑及舊版回復，列出不能自動回滾的 data version，禁止 drop／清 migration history。外部部署只寫操作文件，不自行執行。

## B03 — 模組 HTTP 與安全 transport

**檔案 ownership：** `apps/api/src/app.module.ts`、controller registration／guards／filters／server、contracts meta transport mapping；domain module 不 import Nest／React。生成文件與資料來源同一份 descriptor＋transport declaration，不維護第二套手寫 Zod。

**行為：** release adapter 貢獻 HTTP／callback routes，未選模組 route 不存在；base HTTP 不要求 commerce。維持 inventory 的 REST envelope、HTML／redirect、provider acknowledgement、MCP JSON-RPC 區別。統一日期、分頁、body/query validation 與公開 errors，保留必要原契約。對 CORS／CSRF／rate limit／trusted proxy／body limits 採既有 Fastify／Nest 能力；新 OpenAPI 套件先驗證目前 Zod 3 相容及總複雜度。

**驗收／命令：** `tests/integration/base-http.test.ts`＋現有 auth、host cookies、CSRF、cart、callback、MCP、HTTP contract tests。具體檢查匿名／登入／越權、unknown fields、無效日期、超限 body、429、proxy spoof、未掛載 route。每個 route 的 inputs／outputs／auth／error 可由同一資料源產生文件並機器核對覆蓋。執行 focused tests、`pnpm typecheck`、`pnpm test`、完整 integration、base／commerce 隔離 HTTP smoke。

**回復：** 原 URL／payload 不變；adapter 移動必須整片替換舊 registration，不留雙掛載。新增安全拒絕條件須對照現有 client/provider regression，不用放寬 guard 解測試。

## B04 — 同一 Queue 完整可靠性

**檔案 ownership：** `packages/platform/jobs/src/jobs.ts`、platform expand migration、kernel worker／job-registry／event-delivery／ops-module、outbox、Extension job facade；新增 `tests/integration/queue-reliability.test.ts`／outbox delivery cases。依 [ADR 0035](../../adr/0035-retain-postgres-queue-for-modular-base.md) 保留 `platform_jobs`，不把 PoC package 放進 production。

**先定 Interface 再實作：** persisted job id 與每次 occurrence／claim token 分開。dedupe conflict 回傳既有 id；replaceExisting 在 active 時保存 deferred payload／runAt，不使舊 handler 與新 occurrence 同時自由執行。claim／heartbeat／complete／fail／cancel 都檢查 occurrence fencing；stale owner 的操作回報未套用，不能污染新狀態或計入成功 telemetry。

**完整 F06／F10：** lease／heartbeat、handler timeout＋AbortSignal、每類 concurrency、payload schema/version、取消、attempt/backoff 上限含 crash-only、dead-only 重送、完成保留期與 dedupe horizon。Outbox fan-out 與 marking 仍同交易；未知 job、無效 payload、移除 subscriber 的 pending delivery 有 durable quarantine／診斷／重送政策，不能 log 後當成功。subscriber id 与 `evt:<eventId>:<subscriberId>` 保留。外部副作用只承諾 at-least-once，handler/provider idempotency key 必須跨 crash 穩定。

**验收／命令：** 同一七案例契約加入正式 integration：多連線 dedupe、A→replacement→B→A late ack、同 worker id 跨 generation、live heartbeat／SIGKILL／attempt exhaustion、DLQ 重送、cleanup 後 dedupe、舊 payload。子程序在 claim 後與副作用後各 crash，驗證重啟與副作用去重。原 payment／invoice／notification／ERP／DLQ／outbox flows 回歸；`pnpm typecheck`、`pnpm test`、完整 integration、隔離 Docker／native smoke。timeout／shutdown 不可只測成功短任務。

**移轉／回復：** 用舊 Queue fixture 種 pending/running/dead/completed 與 dedupe/payload，套用新的 expand migration 後逐一恢復；保留外部使用的 job id。claim token 欄位啟用與 dispatcher 切換需明確排他，不能讓舊 worker 無 fencing 寫入新 occurrence。先 stop/drain、確認資料版本再回復舊 release；若某資料狀態不再支援舊版，回復計畫必須明列還原 snapshot 及外部副作用對帳，不能宣称無條件 rollback。

排程完整 cron／timezone／misfire/pause/overlap 由 B05 承接；B04 只交付它所需的可靠 occurrence 執行／查詢能力，不能因此把整體 F07 標完成。
