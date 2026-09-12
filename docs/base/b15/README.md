# B15 — 維運與升級

- 狀態：verified
- 開始：2026-09-11

## 完成條件

- [x] CLI、native／Docker release、DB paired snapshot、rollback 與既有 runbook 的 B15 基準已盤點；不重做 B02 的已驗收 transition 邊界。
- [x] 受權限保護的 `/health/metrics` 提供 queue、scheduler、mail、storage 與 worker heartbeat 的穩定計數；告警門檻寫入 operations runbook。
- [x] 完整 backup／restore 同時支援 native release 與 Docker runtime layout；portable identity 以 release id、version 與 build manifest 為準，不把 Docker 的 `dist/` 當 native release archive。
- [x] 完整 restore 的 scratch／journal 綁定 storage catalogue、支援 clean-cluster recovery，並在 Docker／native 共用可恢復的 transaction boundary。clean-cluster 路徑的證據來自 `tests/integration/full-restore.test.ts` 與 `tests/integration/database-cutover.test.ts`；Docker／native smoke 起的是帶 `POSTGRES_DB` 的既有 live database，走 quarantine 分支，未涵蓋 clean-cluster 路徑。
- [x] Docker／native smoke 實測完整 bundle 的 volume persistence、DB／media hash 與未完成 job 復原。
- [x] `make verify`、完整 Docker／native smoke 與獨立審查通過後，才把本包標為 verified。

## 操作界線

`backup --include-media` 與 `restore --bundle` 都要求 `--external-writers-stopped`：這個確認包含 API、Worker
及一切外部 writer，而不只是資料庫連線。完整 bundle 是 DB＋目前 ready storage objects 的復原點；不取代
ADR 0037 的 release upgrade／rollback scratch-database 流程。共享 S3 prefix 的 manifest 外 key 不會被刪除。

manifest 的 `endpointChecksum` 是 provenance，完整還原刻意不驗證它：其他 snapshot 路徑都會比對這個欄位，
但完整 bundle 存在的目的就包含還原到另一個 cluster，強制相符會讓異地復原直接失效。想確認 bundle 來源時
自行比對這個欄位，不要期待 CLI 幫你擋。

失敗的 recovery 是可回收的狀態，不是只能留著診斷：媒體 replay 在 cutover 之前寫入現役 storage，journal
旁的 `restored-keys.json` 記下該次實際新建的 key，`restore --list-recoveries` 列出未完成的 recovery，
`restore --discard <journal>` 刪掉那些 key、drop 其 scratch database 並移除 journal。cutover 已生效者不可
回收。物件集合本身不是原子的（單一物件靠 exclusive create／`If-None-Match` 保證不被覆寫），回收是補這個
缺口的手段。

還原前會對 object store 實測一次 conditional create：舊版 S3-compatible 實作會忽略未知的 `If-None-Match`
並把覆寫回報成新建，那會讓「hash 不同的物件絕不被覆寫」這個保證變成空話。探測不過就拒絕還原。
