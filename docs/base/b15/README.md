# B15 — 維運與升級

- 狀態：verified
- 開始：2026-09-11

## 完成條件

- [x] CLI、native／Docker release、DB paired snapshot、rollback 與既有 runbook 的 B15 基準已盤點；不重做 B02 的已驗收 transition 邊界。
- [x] 受權限保護的 `/health/metrics` 提供 queue、scheduler、mail、storage 與 worker heartbeat 的穩定計數；告警門檻寫入 operations runbook。
- [x] 完整 backup／restore 同時支援 native release 與 Docker runtime layout；portable identity 以 release id、version 與 build manifest 為準，不把 Docker 的 `dist/` 當 native release archive。
- [x] 完整 restore 的 scratch／journal 綁定 storage catalogue、支援 clean-cluster recovery，並在 Docker／native 共用可恢復的 transaction boundary。
- [x] Docker／native smoke 實測完整 bundle 的 volume persistence、DB／media hash 與未完成 job 復原。
- [x] `make verify`、完整 Docker／native smoke 與獨立審查通過後，才把本包標為 verified。

## 操作界線

`backup --include-media` 與 `restore --bundle` 都要求 `--external-writers-stopped`：這個確認包含 API、Worker
及一切外部 writer，而不只是資料庫連線。完整 bundle 是 DB＋目前 ready storage objects 的復原點；不取代
ADR 0037 的 release upgrade／rollback scratch-database 流程。共享 S3 prefix 的 manifest 外 key 不會被刪除。
