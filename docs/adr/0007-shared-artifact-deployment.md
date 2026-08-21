# 0007. Native 與 Docker 共用同一份 Application Artifact

- 狀態：accepted
- 日期：2026-08-21

## 背景

同時支援 Docker 與原生 Linux 部署，最常見的失敗模式是兩條路徑逐漸分歧：
Docker 上好好的，裝到客戶的 Ubuntu 就壞了，而且症狀無法在本機重現。

## 決策

`scripts/build.mjs` 產生**唯一**的 Application Artifact：`dist/`，內容是
`app/api.js`、`app/worker.js`、`app/cli.js` 與 `admin/` 靜態資源。

- Docker：`Dockerfile` 的 runtime stage 直接 `COPY --from=builder /src/dist`。
- Native：`scripts/build-release.sh` 把同一份 `dist/` 加上**固定版本的 Node runtime**、
  systemd unit 與設定範本，打包成 tarball（環境允許時再打 `.deb`）。

兩邊使用**同一份設定格式**（`commerce.yaml` + 環境變數機密），同一個 `commerce` CLI，
同一組健康端點。差別只有「誰負責重啟」：Docker 是 restart policy，Native 是 systemd。

Native 的目錄佈局：程式在 `/opt/commerce/releases/<version>`，
`/opt/commerce/current` 是 symlink；設定在 `/etc/commerce`；資料在 `/var/lib/commerce`；
記錄走 journald。升級與回退都只是換 symlink 再重啟。

Migration 採 **Expand–Migrate–Contract**：每個 migration 標記 `phase`。
`expand` 與 `migrate` 階段必須讓舊版程式仍能運作，因此 `commerce rollback` 換回舊 symlink 之後
系統仍可用；`contract`（刪欄位／刪表）只能在確定不再回退舊版之後才發布。

## 後果

- 一份 artifact 只需要測一次；Docker Compose smoke test 與 Native smoke test 跑的是同一份程式。
- 正式主機不需要 Node.js、pnpm 或 TypeScript：Release 內附 Node runtime。
- 代價：tarball 較大（含 Node runtime，約數十 MB）。以「安裝零前置條件」換空間，值得。
- 代價：Node 版本由我們決定與更新，主機的 Node 版本無關；安全性更新必須靠我們發新 Release。

## Falsified if

`Dockerfile` 的 runtime stage 不再直接使用 `scripts/build.mjs` 的輸出，
或 `scripts/build-release.sh` 開始為 Native 另外編譯一份程式碼，
或 `docker/entrypoint.sh` 與 `deployments/systemd/*.service` 的啟動參數出現實質差異。
