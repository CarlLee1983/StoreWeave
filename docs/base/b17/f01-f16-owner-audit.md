# B17 F01–F16 owner audit

- 日期：2026-09-12
- 範圍：[Spec 0009 §3](../../specs/0009-complete-modular-base.md#3-完整能力矩陣) 與
  [§8](../../specs/0009-complete-modular-base.md#8-最終驗收)
- 結論：repository-local owner evidence 已逐項核對；B10 缺失的 owner 文件已補回，Extension recurring
  schedule 的斷線已修並加真實 PG regression。完整 Base 仍不能結案，因為 catalog、clean CI、staging、
  merchant UAT、已發布 binary 與真實下游專案證據尚未齊備。

`local-reviewed` 只表示 implementation、文件、故障測試與 caller 在目前 source 可定位，且沒有另列歷史 review
缺口；不代表正式環境
已開通。歷史工作包中的測試數字是當時 checkpoint，最終 source 仍以本輪 `make verify` 與遠端 clean CI
為準。

| 能力 | owner／implementation | 故障測試／caller／文件 | owner 結論與剩餘 gate |
| --- | --- | --- | --- |
| F01 runtime／DI／config／module graph | B01–B02；`kernel/runtime.ts`、`bundle/bootstrap.ts`、`config/schema.ts` | module-graph、release、runtime-lifecycle；B01/B02 evidence | local-reviewed；checksum-bound clean CI 與 published artifact pending |
| F02 HTTP 契約與防護 | B03；`apps/api/src/release-server.ts`、`kernel/http-contract.ts` | HTTP/MCP、Base HTTP、startup catalog；B03 acceptance | local-reviewed；Commerce structural/HTTP golden 已固定，semantic v2 在 composed registry／HTTP 範圍內以逐 facet `remaining` fail-close；SDK/config/CLI 與完整覆蓋仍 pending |
| F03 DB／migration／backup／restore | B01–B02、B15；migrator、CLI、recovery | migration-lock、release-transition、full-restore；B15 runbook | local-reviewed；目前 N/N+1 synthetic drill 不代替已發布舊 binary |
| F04 identity／session／policy／MFA／token | B03、B08、B13；identity/auth、users/token controllers | identity/MFA/session/HTTP/Admin；B08/B13 docs | local-reviewed；真 SMTP 與正式 account rollout pending |
| F05 Mail／Notification | B06–B08、B13；mail、notifications、identity mail | mail failure/unknown result、notification retry、Inbox UI；B06/B07/B08 docs | local-reviewed；real SMTP staging/recipient evidence pending |
| F06 durable Queue／Worker／DLQ | B04；jobs、worker、outbox | queue-reliability、worker recovery/fencing/redrive；B04 acceptance | local-reviewed；正式 cutover 的 stop/drain/external-effect reconciliation pending |
| F07 interval／cron Scheduler | B05；`recurring.ts`、`schedule-spec.ts`、ops HTTP/CLI | DST/misfire/overlap/multi-worker/invalid schedule；B05 acceptance | local-reviewed；B17 補上 Extension schedule 的正式 SDK/host 接線與 regression |
| F08 Storage | B09；storage contract、Local/S3 adapters、controller | storage、S3-compatible、backup/abort/auth tests；B09 acceptance | local-reviewed；授權 staging 的真 S3 endpoint/private URL pending |
| F09 Media | B10；`platform/media`、media controller/Admin | 真 Sharp pipeline、invalid bytes/retry/reference/delete、B17 retention；[B10 acceptance](../b10/acceptance.md) | local-reviewed；真 S3/private-media staging 與 published-release restore pending |
| F10 event／outbox fan-out | B01、B04；event-bus、outbox、event-delivery | fan-out、subscriber removal/quarantine/retry；B04 acceptance | local-reviewed；正式 dispatcher cutover/external effects 與 F06 同 gate |
| F11 Cache／mutex | B11；`platform/cache`、ops cache command | TTL/outage/cross-process/mutex termination；B11 acceptance | local-reviewed；權威資料不依賴 cache，production DB rollout 隨 release gate |
| F12 HTTP client／i18n／crypto | B03、B12；http-client、i18n、crypto | redirect/SSRF boundary/retry/tamper/rotation/timezone；B12 acceptance | local-reviewed；目前 checkpoint 的安全與 MFA rewrap 修正經 Sol/high reviewer 複審後無剩餘 actionable finding；provider live HTTP 仍由 merchant contract/UAT 決定 |
| F13 site shell／Theme／Admin mount | B13–B14；theme/page registry、site、storefront/Admin | missing renderer、permission-filtered navigation、Base storefront；B13 docs | local-reviewed；clean final matrix 尚未在遠端跑 |
| F14 Content／Blog／publishing | B14；content module/controller、legacy media backfill | draft isolation、slug/publish/RSS/sitemap/robots/media digest；B14 docs | local-reviewed；merchant DB/assets backfill 是 rollout evidence |
| F15 Module SDK／example／reproducible build | B01–B03、B16；extension SDK、file-requests、CLI/build | module contract、resource/upload auth、restart flow；B16 docs | local-reviewed；file-requests 是 build/integration example，不冒充第三個 native release identity |
| F16 observability／deploy／upgrade／recovery | B04–B12、B15–B17；logger/audit/health/CLI/runbooks | health/diagnostics/redaction/snapshot/full-restore/smoke | local-reviewed；clean 2×2 smoke artifacts、staging transports、published prior binary pending |

## 不能由 repository 補造的證據

- 一次乾淨 commit 的 `{base, commerce} × {Docker, native}` checksum-bound CI artifacts。
- private-media、真 SMTP、真 S3 staging；Ticket 58–62 的公開 HTTPS merchant UAT。
- Ticket 64／70 的 merchant-enabled refund/invoice query capability、契約與 UAT；Ticket 66 production config。
- 一份實際已發布 prior binary 的升級／回復，以及下一個真實專案的共用／客製／工時／升級成本。

這些項目沒有 target、credentials、provider enablement 或外部資料時維持 pending；本機 mock、MinIO、
synthetic version 或測試收件匣都不能代填。
