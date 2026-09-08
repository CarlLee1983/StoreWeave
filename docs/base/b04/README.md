# B04 — Queue／Outbox

狀態：五片全部實作完成，5b 取得三份獨立 review 且最高等級 finding（`listFailures` 生產規模查詢、第二條免授權 redrive 入口）皆已修並補回歸，全 B04 gates 實跑通過。依賴只以[計畫 §3](../../base-implementation-plan.md#3-依賴圖與階段出口)為準。

## 五片

1. identity／fencing／expand migration（本片）：persisted job id 不變；claim 回傳 job、occurrence、token；active replacement latest-wins deferred；cancel primitive。
2. job descriptor／payload version validation。
3. worker lease heartbeat、timeout／AbortSignal、per-type concurrency、crash exhaustion。
4. Outbox fan-out、durable quarantine 與 subscriber delivery。
5. ops、retention／dedupe horizon、full gates。

## 第五片工作順序

- **5a queue 核心／取消／dead-only retry／retention horizon（implemented；Sol/high PASS）**：保留既有 fenced occurrence 與 `platform_jobs` 唯一 identity；補齊 expected-occurrence cancel、dead-only retry、terminal retention／dedupe tombstone 與由 worker lifecycle 驅動的有界 transactional cleanup。獨立 reviewer 已驗證 cancellation/replace 競爭、expired tombstone cleanup/enqueue interleaving 與 `0006` migration fixture；P0/P1/P2=0。
- **5b public ops（implemented；獨立 review PASS，P0=0）**：以 5a facade 接上 `jobs:read/write`、command idempotency／audit、公開 DLQ／quarantine list/redrive 與 HTTP wiring。outbox redrive 只在 event/schema、持久 frozen snapshot、目前 subscriber 全數驗證後才改狀態；不得把 completed replay 當作 DLQ retry。
- **B04 full gates（已跑，PASS）**：完整 integration、Docker/native smoke 與 release gate 都已實跑並通過，逐項 log 見「full gates evidence」。這一輪 gate 抓到並修掉一個 focused run 看不到的 queue 缺陷（見下方時鐘一節）；gate PASS 仍不等於 5b 已獲獨立 review 簽核。

## 第二片契約與 cutover

- `JobRegistry` 是 job type 的唯一 descriptor owner：每個新 owner 宣告 `jobContractV1` 的每版 Zod schema、`currentVersion`、逐版 upgrader；registry 在 handler 前驗來源版本、逐版升級、再驗 current schema。`enqueue` 只由 registry 寫入 current version，公開 caller 不能指定／偽造 payload version。
- 既有 platform 與 commerce owner，以及隨 release 發行的 demo-erp／ecpay-logistics jobs 都已是明確 v1 schema。timeout／AbortSignal、實際 concurrency enforcement 是第三片，不因本片 metadata 而宣稱已執行。
- 版本未知、schema 無效或少 upgrader，及 unknown job type，都以 occurrence fencing 原子轉成 `quarantined`，保留 `platform_job_quarantine` 的 job id、occurrence、type、原 payload／version、reason；handler 不會執行，也不會被計成功。outbox removed-subscriber quarantine、查詢／redrive、retention 仍分別留在第四、五片。
- SDK 的 `ExtensionJobRegistration.jobContractV1` 是 additive。缺 metadata 的已發行 extension 可被定位，但新 fenced dispatcher 的 preflight 會列出 `owner:type` 並拒絕 cutover；舊 release 可在 owner 遷移前繼續運作。本片不維護第二個永久 legacy dispatcher，也不宣稱所有外部 extension 無條件相容。owner 升級前須補 schemas／upgraders 並以其 pending jobs 做驗證。

## 本片契約與 cutover

- enqueue／replacement 建立 persisted logical `occurrence_id`；claim／reclaim 只輪換 `claim_token`。`heartbeat`、`complete`、`fail` 都以兩者原子比對，stale 回 `applied: false`。Worker 只傳遞 fenced claim，未保留 workerId-only ack 路徑。
- active `replaceExisting` 不改寫 running occurrence；只保存一筆 deferred 資料。有效 complete／fail 才提升它；cancel 清除 deferred，running handler 必須合作結束。
- expand migration `platform/0003_job_occurrence_fencing` 保留既有 id、dedupe、payload、status、attempts；舊列補 occurrence，payload version 預設 1。不可把資料 rollback 等同 git revert。
- 技術強制：新 Worker 的所有 ack 都帶 fencing，stale claim 不會套用。操作前置：切換前必須 stop/drain 舊 dispatcher 並確認其不再持有 DB 寫入權；現有 SQL 無法單靠新欄位阻止仍在執行的舊 binary 發出舊式 UPDATE。

## B04 dispatcher cutover 與回復

1. 先記錄 `commerce doctor` 與受權限 `/health/dependencies` 的 queue/outbox/worker 狀態，停止所有外部 API 寫入者與所有舊 Worker；確認舊 dispatcher 已正常退出、沒有仍持有 lease 的 running job，才可宣告 `--external-writers-stopped`。這個旗標不是把外部 worker 停掉的機制。
2. 使用 release CLI 的配對快照流程，而非單獨跑 migration：`commerce upgrade --release CANDIDATE.tar.gz --external-writers-stopped --no-restart`。它會停止受管理服務、保存來源程式與資料庫的配對快照、套用 expand migration，並輸出 snapshot checksum 與 upgrade journal；保留三者以供 forward resume 或 rollback。完成前不可重啟舊 binary。
3. 以候選 release 檢查 `commerce migrate --status --json` 無 pending migration，再啟動 API/Worker。新 dispatcher 是唯一可以 claim/ack 的寫入者；以 `/health/ready`、`/health/dependencies`、`GET /api/v1/system/jobs/quarantined` 與 `GET /api/v1/system/outbox/failures` 驗證服務與人工處置入口。
4. 回復不是切換 `current` symlink：停止所有 writers 後，使用該次輸出的配對 snapshot/checksum 執行 `commerce rollback --snapshot PATH --checksum sha256:... --yes --external-writers-stopped --no-restart`。它以 scratch DB 驗證後原子切換資料庫與來源 release。快照後的資料保留在 quarantine，不會自動合併；依 job occurrence id、`evt:<eventId>:<subscriberId>` 與 provider idempotency key 對帳外部副作用，再決定是否以新 release 重送。詳見[原生部署的升級與回退程序](../../deployment-native.md#升級)。

## 獨立審查修復（PASS）

- P0：Worker 使用 `staleLockSeconds` 同時設定 claim lease；reclaim 只依 `lease_expires_at`。heartbeat 後不回收，過期才回收。
- P1：legacy `claim_token IS NULL` 只走 NULL-safe reclaim CAS；`0003` 將有歷史 lock 的 lease 明確化，無 lock 仍可恢復。fenced claim 不走 fallback。
- P1：requeue 只允許 dead／completed；running 回 CONFLICT，避免舊 handler 與新 claim 並行。

## 本片檢查

- `pnpm typecheck`：passed。
- `pnpm exec vitest run --project integration tests/integration/queue-reliability.test.ts`：5 passed；使用 Orbstack socket。
- `pnpm exec vitest run --project integration tests/integration/dlq.test.ts tests/integration/worker-recovery.test.ts`：7 passed。
- `pnpm exec vitest run --project unit packages/extensions/demo-erp/test/delivery.test.ts`：12 passed。
- 完整 integration、Docker/native smoke 仍屬後續 gate。

## 第二片檢查

- `pnpm typecheck`：passed。
- `pnpm exec vitest run --project integration tests/integration/job-payload-contract.test.ts tests/integration/queue-reliability.test.ts`：8 passed；真 PG，Orbstack socket。
- 專屬 coverage：v1→v2 decode/upgrade、enqueue current version、invalid/unknown/missing-upgrader/unknown-type durable quarantine（handler 未跑）、legacy extension cutover diagnostic、0001／0002 checksum 與舊 jobs 保留。
- focused PASS 不等於全 B04 完成；全 suite、outbox、Docker/native smoke 仍是最後 gate。

## 第二片獨立 review 修正（PASS）

- P0：registry lookup／decode 與 handler 執行分成 error boundary；handler 的 `PlatformError.notFound` 仍走 retry/dead，不會被誤判為 unknown job quarantine。
- P1：quarantine 先保存被 fenced occurrence 的原 payload/version/reason；若 cancel 已請求則取消並清 deferred，否則提升 deferred 至新 occurrence。stale token 不改 job 或 evidence。
- P1：`Worker.assertReady()` 在 `start()`、`tick()`、claim 前同步執行；worker entrypoint 在報 running 前也接線。legacy owner 缺 metadata 時不寫 heartbeat、不 relay、不 schedule、不 claim。
- P1：recurring integration 的四個 test owner 已補 strict v1 recurring payload schema。
- review-fix evidence：`/tmp/b04-slice2-reviewfix-typecheck.log`、`/tmp/b04-slice2-reviewfix-registry-unit.log`、`/tmp/b04-slice2-reviewfix-payload-queue-recurring.log`、`/tmp/b04-slice2-reviewfix-worker-recovery.log`；獨立 Sol Standards／Spec review PASS。
- P1 follow-up：platform module ownership 與 release manifest pin 都包含 `platform_job_quarantine`；evidence 為 `/tmp/b04-slice2-ownership-release-manifest.log`、`/tmp/b04-slice2-ownership-typecheck.log`；review PASS。

## 下一 session 接手

- 基準為 HEAD `b23658e` 加未提交第一、二片 diff；第二片新增 registry／SDK contract、`0004_job_payload_quarantine`、core/released-extension v1 owner metadata、payload contract unit／integration tests。
- final evidence：`/tmp/b04-slice2-typecheck-final.log`、`/tmp/b04-slice2-job-registry-unit.log`、`/tmp/b04-slice2-payload-final.log`、`/tmp/b04-slice2-focused-final.log`、`/tmp/b04-slice2-unit-final-escalated.log`、`/tmp/b04-slice2-worker-dlq-final.log`、`/tmp/b04-slice2-dlq-final.log`。
- 真 PG 使用 `DOCKER_HOST=unix:///Users/carl/.orbstack/run/docker.sock`；此 pane 的 socket sandbox 存取需正常 approval。

## 第三片：worker execution（Sol/high final review PASS）

- worker 對有效 fenced claim 排程 heartbeat；handler 收到 `AbortSignal`、`occurrenceId` 與同值 `idempotencyKey`（stable provider key），timeout／shutdown 只給有限 grace，未合作或 heartbeat DB outcome 不確定時 library 發 fatal completion、worker entrypoint bounded non-zero exit；execution metadata 正規化、同 concurrency key 衝突 limit 在 registry preflight 拒絕。
- claim concurrency 改成同一 bounded transaction 的兩段：先完整取得所有有限額 policy key 的 sorted xact advisory locks，再以新的 READ COMMITTED snapshot count 未過期 running leases＋`SKIP LOCKED` claim。
- 已有 focused evidence：heartbeat 跨初始 lease；cooperative timeout abort 後 fenced retry；兩 worker 同 key limit 1 且不同 key 可進展；兩個 advisory-lock barrier；noncooperative timeout 與 blocked heartbeat 的 child process non-zero／lease 未 ack；SIGKILL 後 recovery 與 crash-only attempts exhaustion。最新 typecheck PASS。logs：`/tmp/b04-slice3-typecheck-9.log`、`/tmp/b04-slice3-claim-barrier.log`、`/tmp/b04-slice3-shared-final.log`、`/tmp/b04-slice3-process-timeout.log`、`/tmp/b04-slice3-process-heartbeat.log`、`/tmp/b04-slice3-process-crash-exhaustion.log`、`/tmp/b04-slice3-sigkill-recovery-fix.log`。
- 保留失敗 evidence：初版 claim SQL 8 failure `/tmp/b04-slice3-existing-focused.log`；舊完整 recovery run 4 PASS／1 SIGKILL persisted-state failure `/tmp/b04-slice3-worker-recovery-final.log`。短 lease timing/backoff fixture 已修正，最新完整 recovery 7 PASS（含 crash exhaustion）為 `/tmp/b04-slice3b-worker-recovery-exhaustion.log`。
- logical occurrence 沿用 persisted `occurrence_id`，不新增欄位或 migration：claim／reclaim 只輪換 fencing token；普通 fail、crash retry、`retryDead` 保留 occurrence。非-running replacement、running deferred promotion，以及 completed 的明確 requeue 才建立新 occurrence；dead replay 不會為了繞過 provider dedupe 換 key。`JobContext`／extension SDK 透傳 occurrence UUID 作 `idempotencyKey`。
- durable fake-provider ledger 的子程序回歸已加入：provider 先以獨立 transaction commit、再 SIGKILL 未 ack；reclaim retry 以同 key 呼叫 provider 兩次但 ledger effect 一筆，並完成 attempts=2；另一案例連續 SIGKILL 至 maxAttempts 後 dead，仍為同 key／一 effect；running deferred replacement 產生新 occurrence/key，ledger effect 兩筆。後修 focused evidence：`/tmp/b04-slice3b-logical-occurrence.log`（queue+recovery 14 PASS，補前版本）、`/tmp/b04-slice3b-worker-recovery-exhaustion.log`（最新 recovery 7 PASS）、`/tmp/b04-slice3b-worker-execution.log`（5 PASS）、`/tmp/b04-slice3b-payload-contract.log`（5 PASS）、`/tmp/b04-slice3b-registry-unit-final.log`（5 PASS）、`/tmp/b04-slice3b-typecheck-final.log`。full integration、Docker/native、outbox/retention/redrive 仍未跑／不在本片。
- Sol/high final Standards／Spec review PASS，P0／P1=0；第三片不得重開第二片 payload／quarantine/outbox scope。

## 第三片 Sol/high review-fix（final review PASS）

- bounded DB transaction 現在由一個 absolute deadline 支配 acquire、`BEGIN`、`SET LOCAL`、callback 與 `COMMIT`；每段取剩餘時間。timeout 一律 discard leased client；晚到 acquire 也 discard。Pool 設定 node-postgres `connectionTimeoutMillis`，unit 以本機 TCP 消耗 startup bytes 但不回 handshake，確認 driver 自己 timeout/reject 並關閉 remote socket，不把測試 timer 視為 driver 成功。
- terminal complete／fail 在發 mutation 前停止新 heartbeat 並等待已開始 heartbeat 的確定 outcome；其成功才可 ack，stale／timeout heartbeat 一律 fail-stop，沒有在清 token 後把晚 heartbeat 的 `applied:false` 誤判為 worker fatal。真 PG gate 覆蓋 complete、retry、dead、deferred replacement；真正 stale heartbeat 仍拒絕 terminal ack。
- payload quarantine 的 stale `applied:false` 現在建立 `WorkerFatalError` 並 resolve `waitForFatal`，不計入 processed／failed、沒有 quarantine evidence 或下一個 claim。mounted extension job 的實際 `ExtensionHost` registry bridge 已驗證 signal、`occurrenceId`、同值 `idempotencyKey`。
- lifecycle process fixture 已補完整 worker timing/config，驗 hung shutdown、SIGTERM/SIGINT repeated signals、logger failure 時的一次 cleanup 與 bounded non-zero。它只驗 kernel Worker/library shutdown contract；`apps/worker/src/main.ts` 的 production entrypoint 仍是將 `waitForFatal` 交給 bounded cleanup/non-zero exit 的 source boundary，並沒有把 fixture 宣稱為 entrypoint e2e。
- review-fix evidence：`/tmp/b04-slice3-reviewfix-db-red.log`（修前 absolute-deadline red）、`/tmp/b04-slice3-reviewfix-db-driver.log`（DB 5 PASS，真 driver handshake/socket close）、`/tmp/b04-slice3-reviewfix-unit-db-lifecycle.log`（首次 sandbox TCP listener EPERM retained）、`/tmp/b04-slice3-reviewfix-unit-final.log`（DB/lifecycle 9 PASS）、`/tmp/b04-slice3-reviewfix-worker-execution.log`（10 PASS）、`/tmp/b04-slice3-reviewfix-runtime-lifecycle.log`（11 PASS）、`/tmp/b04-slice3-reviewfix-payload.log`（6 PASS）、`/tmp/b04-slice3-reviewfix-worker-recovery.log`（7 PASS）、`/tmp/b04-slice3-reviewfix-queue.log`（8 PASS）。
- latest fatal-boundary P1：`apps/worker` 的實際 entrypoint 以同一 once-close owner 交給 signal shutdown 與 `waitForFatal`；fatal／cleanup logging 皆隔離，fatal resolve 或 reject、cleanup reject 或 deadline 都會在 bounded cleanup 後 fail-stop `exit(1)`。child-process coverage 為 `/tmp/b04-slice3-reviewfix-fatal.log`（5 PASS），既有 lifecycle 為 `/tmp/b04-slice3-reviewfix-fatal-lifecycle.log`（4 PASS），typecheck 為 `/tmp/b04-slice3-reviewfix-fatal-typecheck.log`。final Sol review 已關閉此 finding；不代表 B04 complete。

## 第四片：Outbox fan-out／delivery quarantine（Sol final review PASS）

- `platform/0005_outbox_subscriber_snapshot_quarantine` 是 append-only expand migration；保留 `0001`–`0004` SQL/checksum。新 command publish 透過 `CommandBus` 在同一業務交易把排序去重的 `subscriber_ids` 寫入 outbox；`[]` 是合法空 fan-out，只有 legacy `NULL` 表示未知。
- relay 每次只鎖定一個 pending event 並在該 transaction 內驗 event/version/payload、依 frozen snapshot enqueue 全部 `platform.event.deliver`、最後標 `relayed`。任何 enqueue 失敗回滾該 event 的全部 job，再以 transaction 外 `pending` CAS 持久 attempt/backoff；未知／版本／payload 或未知 legacy snapshot 寫入 `platform_outbox_quarantine`，不阻塞鄰近正常 event。
- 舊 `NULL` snapshot 只在 `occurred_at` 對應已記錄的 effective release 時自動重建；無完整可信 history 一律 `legacy_subscriber_snapshot_unknown`。`repairAndRedriveOutbox` 是內部、可執行且有 audit evidence 的路徑：先鎖列並驗 event/schema/所有 subscriber，才在同一 transaction repair、解封 delivery job、redrive/audit；保留舊 quarantine evidence。公開授權與 ops UI 屬第五片。
- delivery 前置錯誤只有 `JobQuarantineError` 的 `subscriber_missing`、`event_unknown`、`event_version_invalid`、`event_payload_invalid`，由既有 fenced job quarantine 保存；subscriber handler 已開始後的任何業務錯誤（包含 NOT_FOUND）維持 retry/dead。`EventHandlerContext` 與 extension bridge 提供穩定 `eventId`/`evt:<eventId>:<subscriberId>`，不混用 execution occurrence key。
- focused true-PG：`/tmp/b04-slice4-outbox-pg-final.log` 5 PASS（第二 enqueue rollback、併發 relay、snapshot removed subscriber/redrive、poison isolation、`[]`/NULL repair、business retry）；`/tmp/b04-slice4-event-sigkill-final.log` 1 PASS（provider 獨立 commit 後 SIGKILL/reclaim，兩次 call 同 `evt:` key、durable ledger 一 row/effect）；修正 migration inventory 後 `/tmp/b04-slice4-queue-final.log` 8 PASS、`/tmp/b04-slice4-base-release-final.log` 3 PASS；`/tmp/b04-slice4-typecheck-final-handoff.log` PASS、`/tmp/b04-slice4-release-manifest-final.log` 5 PASS、`/tmp/b04-slice4-diff-check-final.log` PASS。完整 B04 gates、retention/dedupe horizon、公開 ops/authorization 仍是第五片，B04 仍 in_progress。

## 第四片 Sol review 修正（final review PASS）

- P0：`0002_worker_heartbeat` 恢復已發布的 exact SQL bytes；固定 pre-B04 fixture 與 bundle pin 一起驗證 `sha256:b0a59b…`，既有舊 history 現可只 forward expand `0003`–`0005`。
- P1：legacy `NULL` snapshot 只接受唯一、時間可識別且由 `release-history` 完整 validator 驗過 checksum、schema、metadata 與 ownership 的 effective manifest。checksum drift、無效 ownership/schema、同 timestamp 歧義與缺 history 都保持 `NULL` 並 quarantine 為 `legacy_subscriber_snapshot_unknown`；可信唯一 case 仍自動重建。
- P1：non-NULL frozen snapshot 是 redrive 的唯一來源；caller 必須 canonical sorted/deduped exact match，omission／extra／empty 都在任何 job、outbox 或 audit mutation 前拒絕。NULL case 仍只可透過含 evidence 的 audited repair。
- review-fix evidence：修前 `/tmp/b04-slice4-reviewfix-red.log`（真 exit 1）；修後 focused PG `/tmp/b04-slice4-reviewfix-focused.log`（19 PASS）、release transition `/tmp/b04-slice4-reviewfix-release-transition-final.log`（29 PASS）、manifest/base release `/tmp/b04-slice4-reviewfix-manifest-base-release.log`（8 PASS）、typecheck `/tmp/b04-slice4-reviewfix-typecheck.log`。同 Sol final Standards／Spec review PASS，P0／P1／P2=0；failure logs 與 closure evidence 均保留。full B04 gates 與第五片仍未執行。

## 第五片 5a（Sol/high review PASS）

- `platform/0006_job_retention_dedupe_horizon` 是 append-only expand migration；`0001`–`0005` SQL/checksum 不變。它只補 terminal row 的預設 7/30 天期限，不在 migration 期間刪除舊資料。`platform_jobs` 仍是唯一 persisted identity。
- runtime 唯一設定源為 `worker.completedPayloadRetentionDays`、`cancelledPayloadRetentionDays`（皆預設 7）與 `dedupeHorizonDays`（預設 30）；schema 在 startup 前拒絕 horizon 小於任一 retention。terminal complete、pending cancel、running cancel 的 fenced settle／reclaim 均保存 `retain_until`／`dedupe_until`。
- worker tick 以既有 bounded transaction 驅動小批 `cleanupExpired`，不新增 B05 cron：無 dedupe key 的到期 terminal row 刪除；有 key 的 row 轉 `dedupe_retained` 並清除 payload、error、lease、deferred 等 payload-bearing state；horizon 到期才刪 tombstone。dead、running、pending、quarantined 與 quarantine evidence 不由此清理。enqueue 對 expired tombstone 以 row lock/delete/reinsert 保護；horizon 內回原 id，`replaceExisting` 復活同 id 的新 occurrence，horizon 後才有新 id。
- `cancel` 必帶 expected occurrence：pending 直接 cancelled，running 清 deferred 並設 cancellation request；heartbeat 看見 request 後 abort handler，fenced settle／reclaim 才 cancelled。stale occurrence、重複 cancel、terminal 一律 conflict；不重設 running claim／lease。`retryDead` 僅 `dead → pending`、attempts=0，並保留 job/logical occurrence/payload/dedupe/provider key；race 僅一方成功。既有 `requeue(completed)` 的明確新 occurrence 語意不變。
- focused true-PG：queue retention 現為 6 PASS（新增 cancellation→replacement 與 cleanup/enqueue race 的兩種 replacement mode）；queue reliability 8 PASS、release transition 29 PASS。獨立 Sol/high reviewer 檢查上述 race 與 `0006` 轉換 fixture 後確認 P0/P1/P2=0。
- 5a review 關閉的 P1：running job 收到 cancel 後的 replacement 不可清掉 cancel request；expired tombstone 的清理與 enqueue interleaving 不可在 conflict 後選到已刪資料。前者保留 cancel 並禁止 deferred replacement，後者以第二次 `ON CONFLICT DO NOTHING` 重試 insert。
- 5a 已完成但不是全 B04 complete；5b independent review 與 full B04 gates 仍 pending。

## 第五片 5b public ops 與 full gates

- `platform.jobs.listQuarantinedJobs`／`platform.outbox.listFailures` 只讀 metadata（`jobs:read`）；`platform.jobs.retryJob`、`platform.jobs.redriveQuarantinedJob`、`platform.outbox.redriveFailure` 都是 `jobs:write`、`idempotency: 'required'` 且帶 audit descriptor，由 `CommandBus` 在同一交易內宣告 idempotency key 並寫 audit。HTTP 對應 `GET/POST /api/v1/system/jobs/{dead,quarantined}`、`GET/POST /api/v1/system/outbox/failures`，controller 只轉發到 Bus。
- `platform.event.deliver` 的 job quarantine 不能走 `redriveQuarantinedJob`：它回 CONFLICT，強制改走 `platform.outbox.redriveFailure`，避免繞過 frozen snapshot 驗證。`repairAndRedriveOutbox` 先鎖 outbox 列（`FOR UPDATE`）、驗 event/version/payload、比對 caller 與持久 frozen snapshot 完全相等、確認每個 subscriber 目前都存在，才會 repair／解封 delivery job／改狀態並寫 audit。`relayed` 事件沒有任何 quarantined delivery 時直接 CONFLICT，不把已完成的投遞當 DLQ retry。
- `createOpsModule` 的 `EventBus`／`OutboxStore` 依賴改為必填，移除原本 optional 造成的 runtime throw；型別層即保證 recovery 路徑可用。

### full gates evidence（本輪實跑）

| gate | 結果 | log |
| --- | --- | --- |
| `pnpm typecheck` | PASS | `/tmp/b04-gates-typecheck.log` |
| `pnpm test:unit` | 61 files／752 PASS | `/tmp/b04-gates-unit.log` |
| `pnpm test:integration`（真 PG） | 85 files／713 PASS | `/tmp/b04-gates-integration.log` |
| `STOREWEAVE_RELEASE=base pnpm smoke:docker` | PASS（含 base jobs／quarantined／outbox failures 端點） | `/tmp/b04-gates-smoke-docker-base.log` |
| `STOREWEAVE_RELEASE=commerce pnpm smoke:docker` | 66 通過／0 失敗 | `/tmp/b04-gates-smoke-docker-commerce.log` |
| `STOREWEAVE_RELEASE=base pnpm smoke:native` | PASS | `/tmp/b04-gates-smoke-native-base.log` |
| `STOREWEAVE_RELEASE=commerce pnpm smoke:native` | 65 通過／0 失敗 | `/tmp/b04-gates-smoke-native-commerce.log` |
| `pnpm typecheck:admin`／`pnpm test:admin` | PASS／26 files 314 PASS | `/tmp/b04-gates-admin.log` |

### full gates 抓到的缺陷：enqueue 用呼叫端時鐘

第一輪完整 integration 有 5 個 `queue-reliability` 失敗（`/tmp/b04-gates-integration-red.log`），全部是「enqueue 後立刻 claim 取不到」。原因是 `JobQueue.enqueue` 以 `new Date()`（呼叫端時鐘）寫 `run_at`，而 `claim` 用資料庫 `now()` 過濾 `run_at <= now()`；只要呼叫端時鐘領先 PG，剛入列的工作就會暫時取不到。這在 focused run 不會出現，只有完整 gate 的負載才穩定重現——focused PASS 不等於 gate PASS 的具體案例。

修法是把佇列的時間權威收回資料庫：未指定 `runAt` 時由 `now()` 產生，明確排程的未來時間仍照呼叫端的值。回歸測試 `claims immediately when the caller clock runs ahead of the database clock` 以 `vi.useFakeTimers({ toFake: ['Date'] })` 把呼叫端時鐘推前 60 秒，驗證立即可 claim，同時驗證明確的未來 `runAt` 仍不可 claim。修前 red `/tmp/b04-clock-skew-red.log`（1 failed），修後 green `/tmp/b04-clock-skew-green.log`（9 passed）。

### 5b 獨立 review（三份，P0 全數關閉）

三位獨立 reviewer 分別審查 5b：兩份 Standards／Spec（各自實跑 typecheck 與 focused 真 PG 測試，其中一份另以 200k／400k 級資料實測查詢計畫）與一份合併審查。契約四項判定一致：授權、`idempotency: 'required'` 與 audit 都由 `CommandBus` 在同一交易強制（不是 controller）且授權早於 input parse；redrive 的鎖列→event/schema→frozen snapshot 完全相等→subscriber 現存四段驗證全在任何寫入之前；公開路徑只呼叫 `retryDead`（SQL 硬性 `status = 'dead'`），`requeue(completed)` 未對外曝露，relayed 事件只 redrive `status = 'quarantined'` 的 delivery job、沒有可 redrive 的就 CONFLICT。錯誤外洩面也追過：非 `PlatformError` 一律經 `toPublicError`，`details` 只在 `VALIDATION_ERROR` 回傳，且有含密碼訊息的回歸測試。

#### P0／P1-1：`listFailures` 在生產規模下不會回應（已修，附量體證據）

兩位 reviewer 各自以獨立資料量實測同一個缺陷：rows 與 count 兩支查詢的述詞是 `status IN ('dead','quarantined') OR <相關子查詢>`，`OR` 迫使子查詢對幾乎每一列 outbox 求值，而 `dedupe_key LIKE ('evt:' || event.id::text || ':%')` 在非 C collation 下用不到 `dedupe_key` 的 unique btree。`platform_outbox` 在 B04 全程沒有 retention，會隨每筆領域事件無上限成長且幾乎全是 `relayed`，所以複雜度是 O(事件數 × quarantine 數)。這正是 cutover 程序（本檔上方第 3 步）要求操作者呼叫、也是 `scripts/smoke.sh` 檢查的端點；每次請求佔住一條 pool 連線直到 timeout。

修法採 reviewer 建議：兩個候選集合 `UNION`——`status IN ('dead','quarantined')` 走新的 partial index，delivery 那半從 `platform_jobs` 的 quarantined partial index 出發、以 `split_part(dedupe_key, ':', 2)::uuid` 還原 outbox id 再走主鍵 join 回來；`total` 用同一組候選集合計數。append-only `platform/0007_ops_listing_indexes` 補 `platform_outbox (occurred_at DESC, id DESC) WHERE status IN ('dead','quarantined')`、`platform_jobs (dedupe_key) WHERE status='quarantined' AND type='platform.event.deliver'`，以及 `listQuarantined`／`listDead` 的兩個 partial index；`0001`–`0006` SQL/checksum 不變。

同一份資料（200k relayed outbox、205k delivery job、5k quarantine，真 PG）上的對照：修前的相關子查詢寫法在 60 秒 `statement_timeout` 下被取消，修後 `listFailures` 為 **135 ms**（`/tmp/b04-5b-listfailures-scale.log`）。`tests/integration/outbox-failures-scale.test.ts` 把這件事變成常設回歸（60k／2k 量級，斷言 5 秒內完成）——其餘 outbox 測試都跑在近乎空的表上，正是這個缺陷過去測不出來的原因。

#### P1-2：第二條免授權的 redrive 入口（已移除）

`Worker.repairAndRedriveOutbox` 是第四片留下的內部路徑，註解寫「公開授權屬第五片」；第五片交付後它只剩測試在呼叫，卻仍是一條不需 `jobs:write`、不寫 `platform_audit_log`、不需 idempotency key 就能改 outbox 狀態並解封 delivery job 的入口。已刪除該方法，六處測試改由 `platform.outbox.redriveFailure` 驅動。這同時補上 reviewer 指出的覆蓋缺口：subscriber 全數驗證、frozen snapshot 的 omission／extra／empty 拒絕、NULL legacy snapshot 的 audited repair，現在都由公開 command 路徑證明，而不是只由內部路徑。

#### 其餘 P2 處置

- `platform_outbox` store 的 `markFailed`、`repairSubscriberSnapshot`、`redriveQuarantined`、`auditDeliveryRedrive` 四個無呼叫者的方法刪除。`markFailed` 另有實質風險：它的 UPDATE 沒有 status guard，會把 `relayed` 事件打回 `pending`／`dead` 造成重複投遞。刪掉之後「所有 redrive 都在 command 交易內」成為結構性事實而不只是慣例。
- 三處重複的 `subscriber_ids` 形狀檢查收斂成 `asSubscriberSnapshot()`；巢狀 IIFE 抽成 `resolveFrozenSnapshot()`。
- `outboxFailureDto` 新增 `snapshotState: 'frozen' | 'legacy_unknown' | 'invalid'`：原本損毀的 snapshot 與「legacy 未知」都顯示成 `null`，操作者會以為可以修但實際無路可走。查詢的 `WHERE` 也補上 status 白名單，避免非預期 status 讓整頁 output 驗證失敗變成 500。
- `repairAndRedriveOutbox` 的 status 前置檢查提前到所有寫入之前；`platform_outbox` store 的四處裸 `Error` 改成 `PlatformError`；`EVENT_DELIVERY_JOB` 與 `evt:` key 的組成下沉到 `@storeweave/contracts` 共用；`runtime.ts` 的重複 import 合併；`compatibility-inventory.md` 的行號引用補回。
- NULL legacy snapshot 修成空集合需要明確 `acknowledgeEmptyFanout: true`，預設值不可能讓一次誤操作把事件變成零 fan-out。
- 重包 snapshot 錯誤時保留 cause，但掛在 Error 上而不是傳成 `details`——`details` 會在 `VALIDATION_ERROR` 回給呼叫端，傳進去等於把內部訊息外洩。
- `reason`／`lastError` 會帶原始例外訊息一項刻意不改：它是 `jobs:read` 維運者診斷死信的唯一線索，完整 payload 仍只留在 evidence 表。

#### 補上的測試

`platform.jobs.retryJob` 現在驗證缺 idempotency key 會被拒、同一把 key 重放回傳同一結果且 `jobs.retried` audit 只有一筆；另兩個新 command 也驗證缺 key 被拒。加上公開路徑改寫與 scale 測試，`dlq` 與 `outbox-delivery` 由 19 案增為 22 案。
