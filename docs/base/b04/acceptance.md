# B04 驗收追蹤：Queue／Outbox

狀態：五片全部 review PASS、全 gates 實跑 PASS。5b 獨立 review P0=0，其 P1（`listFailures` 查詢成本）與 P2 已修並補回歸。範圍為 F06／F10 的可靠 occurrence 執行與 Outbox；排程 cron／timezone／DST／misfire 屬 B05，不在本包。

依據：[B04 card](../b00/next-work-cards.md#b04--同一-queue-完整可靠性)、[Spec 0009 F06/F10](../../specs/0009-complete-modular-base.md#3-能力範圍與現況)、[ADR 0035](../../adr/0035-retain-postgres-queue-for-modular-base.md)、[依賴表](../../base-implementation-plan.md#3-依賴圖與階段出口)。依賴只以上述表為準。

第一片 source review 已確認 occurrence／claim token、deferred replacement 與 migration evidence；其餘未讀範圍仍不作不存在結論。

| 驗收項目 | owner | evidence | status |
| --- | --- | --- | --- |
| job id 與 logical occurrence／claim token 分離；所有狀態操作 fencing | B04 Queue | source review PASS：late ack、heartbeat lease、expiry reclaim／same workerId stale ack；claim/reclaim 換 token 而保留 occurrence，replacement 才換 occurrence | implemented; reviewed PASS |
| dedupe 回既有 id；active replace 保存 deferred payload/runAt | B04 Queue | source review PASS：四連線；A→replace→B；same workerId late ack | implemented; reviewed PASS |
| lease 與 live heartbeat | B04 Queue | 第一片 source review + 第三片 true-PG heartbeat crosses initial lease；blocked heartbeat child process fatal/non-zero and lease unacked；Sol/high final review PASS | implemented; reviewed PASS |
| handler timeout 與 AbortSignal；shutdown 非短任務 | B04 Queue | cooperative timeout sees abort then fenced retry；noncooperative timeout child exits non-zero without ack；SIGTERM deadline case。完整 post-fix rerun 已含在 `/tmp/b04-gates-integration.log`（85 files／713 PASS） | implemented; gates PASS |
| 每 type concurrency 與工作隔離 | B04 Queue | same-key two-worker limit 1/no overlap, different-key progress；two true-PG advisory-lock barriers prove fresh snapshot/all policy keys；完整 integration rerun 一併通過 | implemented; gates PASS |
| payload schema/version 與舊 payload | B04 Queue | registry source schema → step upgrader → current schema；enqueue writes owner current version；v1→v2、handler NOT_FOUND retry and legacy preflight no-side-effect true-PG test | implemented; reviewed PASS |
| cancel 受 fencing 保護 | B04 Queue | source review PASS：running cooperative primitive／deferred 清除真 PG regression；ops 屬第5片 | implemented; reviewed PASS |
| attempt/backoff 上限含 crash-only exhaustion | B04 Queue | fake provider 以 occurrence key 獨立 commit 後，兩次 SIGKILL 都消耗 attempt；reclaim 後 attempts=2 dead，provider calls=2／unique effect=1。`/tmp/b04-slice3b-worker-recovery-exhaustion.log` 7 PASS；Sol/high final review PASS | implemented; reviewed PASS |
| dead-only replay | B04 Queue | `retryDead` 只放行 `dead`（與 requeue 分開，completed 只走明確 requeue）；`dlq.test.ts` 驗「已完成的工作不能用死信重送」與缺 idempotency key／越權被拒；Docker／native smoke 的 DLQ 段落一併通過 | implemented; gates PASS |
| completed retention 與 dedupe horizon | B04 Queue | `queue-retention.test.ts` 6 PASS：retention tombstone 保留 dedupe identity、horizon 後可用新 id、replaceExisting 復活 tombstone、cleanup 不動 active/dead/quarantined、cleanup 與 enqueue interleaving | implemented; gates PASS |
| Outbox fan-out 與 marking 同交易 | B04 Queue | `outbox-delivery.test.ts` true PG：第二 subscriber enqueue throw → zero jobs/未 relayed；重試每 snapshot subscriber 一 job；two relay workers 不重複。review-fix `/tmp/b04-slice4-reviewfix-focused.log` 19 PASS | implemented; Sol final review PASS |
| unknown job、invalid payload、removed subscriber durable quarantine | B04 Queue | job payload quarantine 保持第二片 PASS；第四片另有 unknown/version/payload outbox quarantine、removed subscriber typed `subscriber_missing` job quarantine，normal event continues；internal redrive prevalidates all subscribers before any status write and preserves evidence/audit。non-NULL frozen snapshot 拒絕 caller omission／extra／empty 並不寫任何 job/outbox/audit | implemented; Sol final review PASS |
| subscriber id 與 `evt:<eventId>:<subscriberId>`；外部 idempotency 穩定 | B04 Queue | command snapshot 固定 sorted ids；delivery/extension context gets stable event key. Child real PG provider ledger commits before SIGKILL, reclaim calls provider twice with same `evt:` key while ledger has one effect row: `/tmp/b04-slice4-event-sigkill-final.log` 1 PASS | implemented; Sol final review PASS |
| migration：舊 pending/running/dead/completed、id/dedupe/payload 恢復 | A + B04 Queue | prior 0003/0004 evidence unchanged; fixed old SQL fixture proves released 0002 `sha256:b0a59b…` expands forward. append-only 0005 adds nullable snapshot + outbox quarantine/audit. NULL is quarantined unless a unique fully-validated effective-history reconstruction succeeds; explicit repair requires evidence | implemented; Sol final review PASS |
| migration rollback 限制與 dispatcher 排他 | A | 程序寫在 README「B04 dispatcher cutover 與回復」與[原生部署](../../deployment-native.md#升級)；配對 snapshot／checksum／journal、resume 與 rollback 由 `cli-upgrade-paired`、`database-cutover`、`legacy-safety-snapshot`、`release-transition` 在完整 integration 中通過。實機 stop/drain 與外部副作用對帳演練仍屬部署時作業 | documented; drill pending |
| 七案例與 payment/invoice/notification/ERP/DLQ/outbox 回歸 | B04 Queue | 完整 integration 85 files／713 PASS 一次涵蓋七案例與 payment／invoice／notification／ERP／DLQ／outbox flows：`/tmp/b04-gates-integration.log` | implemented; gates PASS |
| full checks 與 native/Docker gates | A | typecheck PASS、unit 752 PASS、integration 713 PASS、Docker smoke base＋commerce PASS、native smoke base＋commerce PASS、admin typecheck/test PASS；logs 見 B04 README 的 evidence 表 | implemented; gates PASS |

第三片 evidence logs：`/tmp/b04-slice3-typecheck-9.log`、`/tmp/b04-slice3-claim-barrier.log`、`/tmp/b04-slice3-shared-final.log`、`/tmp/b04-slice3-process-timeout.log`、`/tmp/b04-slice3-process-heartbeat.log`、`/tmp/b04-slice3-process-crash-exhaustion.log`、`/tmp/b04-slice3-sigkill-recovery-fix.log`，及後修 `/tmp/b04-slice3b-logical-occurrence.log`（14 PASS）、`/tmp/b04-slice3b-worker-recovery-exhaustion.log`（7 PASS）、`/tmp/b04-slice3b-worker-execution.log`（5 PASS）、`/tmp/b04-slice3b-payload-contract.log`（5 PASS）、`/tmp/b04-slice3b-registry-unit-final.log`（5 PASS）、`/tmp/b04-slice3b-typecheck-final.log`。保留 failures：`/tmp/b04-slice3-existing-focused.log`（初版 claim SQL）與 `/tmp/b04-slice3-worker-recovery-final.log`（4 PASS／1 pre-fix SIGKILL persisted-state failure）。

Sol/high review-fix evidence：DB absolute deadline red `/tmp/b04-slice3-reviewfix-db-red.log`，DB driver／socket close 5 PASS `/tmp/b04-slice3-reviewfix-db-driver.log`，worker execution heartbeat terminal race 10 PASS `/tmp/b04-slice3-reviewfix-worker-execution.log`，mounted extension bridge 11 PASS `/tmp/b04-slice3-reviewfix-runtime-lifecycle.log`，stale quarantine 6 PASS `/tmp/b04-slice3-reviewfix-payload.log`，recovery 7 PASS `/tmp/b04-slice3-reviewfix-worker-recovery.log`，queue 8 PASS `/tmp/b04-slice3-reviewfix-queue.log`。Sol/high final Standards／Spec review PASS，P0／P1=0。

latest fatal-boundary P1 source fix：production `apps/worker/src/main.ts` 使用同一 once-close owner 串接 signal shutdown 與 `waitForFatal`。每次 fatal／cleanup logging failure 均隔離；fatal promise resolve/reject、cleanup reject、cleanup deadline 都會在 bounded cleanup 後 non-zero exit，且 repeated fatal/shutdown interaction 只呼叫 cleanup 一次。child-process `/tmp/b04-slice3-reviewfix-fatal.log` 5 PASS，kernel lifecycle `/tmp/b04-slice3-reviewfix-fatal-lifecycle.log` 4 PASS，typecheck `/tmp/b04-slice3-reviewfix-fatal-typecheck.log` PASS；final Sol review 已關閉此 finding。

第四片同 Sol final Standards／Spec review PASS，P0／P1／P2=0；修前 failure logs 與 closure evidence 均保留。第五片與 full gates 仍 pending；前四片 reviewed PASS 不構成全 B04 accepted 證據。

## 第四片接手

範圍：outbox atomic fan-out、固定 subscriber snapshot、delivery durable quarantine／redrive、以及 `evt:<eventId>:<subscriberId>` idempotency。不得重開前三片已 review PASS 的 occurrence、fencing、payload 或 worker execution；第五片仍負責 ops authorization、retention／dedupe horizon 與 full gates。

## full gates（本輪實跑）

typecheck PASS、`pnpm test:unit` 61 files／752 PASS、`pnpm test:integration` 85 files／713 PASS、`smoke:docker` 與 `smoke:native` 的 base 與 commerce 四趟全通過、admin typecheck／test PASS。逐項 log 見 B04 README 的 full gates evidence 表。

第一輪完整 integration 有 5 個 `queue-reliability` 失敗，根因是 `JobQueue.enqueue` 以呼叫端時鐘寫 `run_at` 而 `claim` 用資料庫 `now()` 過濾；已把預設 `run_at` 改由資料庫產生，並補上「呼叫端時鐘領先」的回歸測試。失敗 log `/tmp/b04-gates-integration-red.log`、修前 red `/tmp/b04-clock-skew-red.log`、修後 green `/tmp/b04-clock-skew-green.log` 均保留。

5b 共取得三份獨立 review，最高等級 finding 是 `listFailures` 在生產規模下不會回應（兩位 reviewer 各自以 200k／400k 級資料實測，一位判 P0、一位判 P1），以及 `Worker.repairAndRedriveOutbox` 這條免授權、不寫 audit 的第二個 redrive 入口。兩者都已修：查詢改為兩個候選集合 UNION 並補 `platform/0007_ops_listing_indexes`，同資料量上由「60 秒 timeout 被取消」變成 135 ms（`/tmp/b04-5b-listfailures-scale.log`），並以 `tests/integration/outbox-failures-scale.test.ts` 常設回歸；worker 入口刪除，測試全改由公開 command 驅動，順帶把 subscriber 驗證、frozen snapshot 拒絕與 NULL repair 三條契約的證明從內部路徑移到公開路徑。其餘 P2 與補測見 [B04 README 的 5b 獨立 review 段落](README.md)。

仍未補的缺口：HTTP 層只驗到狀態碼形狀，沒有帶真實資料的 list 與 redrive happy path，也沒有多列資料下的分頁與排序測試；`platform.outbox.redriveFailure` 缺 HTTP 層 FORBIDDEN 案例。Bus 層對應行為都已有真 PG 覆蓋。
