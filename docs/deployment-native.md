# 原生 Linux 部署（Ubuntu / Debian x86-64）

**正式主機不需要安裝 Node.js、pnpm、TypeScript 或任何編譯工具。**
Release tarball 內含固定版本的 Node runtime、已編譯的 JavaScript、Admin 靜態資源、
Theme、Migration 與 Extension。

## 產生 Release

在建置機（macOS 或 Linux 都可以）：

```bash
pnpm install
pnpm build:release
```

產出：

```
release/commerce-<version>.tar.gz        約 48 MB（含 Node runtime）
release/commerce_<version>_amd64.deb     建置機有 dpkg-deb 時才會產生
```

可用環境變數調整：`COMMERCE_RELEASE_VERSION`、`COMMERCE_NODE_VERSION`（預設 22.17.1）、
`COMMERCE_TARGET_ARCH`（預設 x64）。

## 安裝

```bash
scp release/commerce-1.0.0.tar.gz server:/tmp/
ssh server
sudo apt-get install -y postgresql-client       # 只有備份／還原需要
mkdir -p /tmp/rel && tar -xzf /tmp/commerce-1.0.0.tar.gz -C /tmp/rel --strip-components=1
cd /tmp/rel && sudo ./scripts/install.sh
```

`install.sh` 會做這些事：

1. 建立系統使用者／群組 `commerce`
2. 建立目錄：`/opt/commerce/releases`、`/etc/commerce`、`/var/lib/commerce`、`/var/log/commerce`
3. 把程式安裝到 `/opt/commerce/releases/<version>`，並把 `/opt/commerce/current` 指過去
4. 建立 `/usr/local/bin/commerce`（指向 `current/bin/commerce` 的 symlink）
5. 放置 `commerce.yaml` 與 `commerce.env` 範本（`commerce.env` 權限 0600）
6. 安裝並 enable systemd unit（環境沒有 systemd 時會略過並提示）

用 `.deb` 安裝則是 `sudo dpkg -i commerce_1.0.0_amd64.deb`，postinst 做同樣的事。

## 設定

編輯 `/etc/commerce/commerce.env`（0600，root:commerce）：

```
DATABASE_URL=postgres://commerce:...@127.0.0.1:5432/commerce
COMMERCE_PUBLIC_URL=https://shop.example.com
COMMERCE_ADMIN_TOKEN=<openssl rand -hex 32>
COMMERCE_MCP_TOKEN=<openssl rand -hex 32>
DEMO_ERP_API_KEY=<客戶提供>
```

編輯 `/etc/commerce/commerce.yaml`：店名、幣別、Theme 選項、要啟用的 Extension。
結構定義在 `deployments/commerce.schema.json`，編輯器可直接套用。

啟動：

```bash
sudo -u commerce commerce install --skip-migrate   # 只檢查設定與目錄
sudo -u commerce commerce migrate                  # 套用資料庫 schema
sudo systemctl start commerce-api commerce-worker
sudo -u commerce commerce doctor                   # 逐項驗證安裝狀態
```

## 目錄佈局

| 路徑 | 內容 |
| --- | --- |
| `/opt/commerce/releases/<version>/` | 程式（app、runtime、admin、systemd、config 範本） |
| `/opt/commerce/current` | 指向目前版本的 symlink |
| `/opt/commerce/previous` | 上一版的路徑（升級時寫入，供 rollback 使用） |
| `/etc/commerce/commerce.yaml` | 設定 |
| `/etc/commerce/commerce.env` | 機密（0600） |
| `/var/lib/commerce/` | 持久資料、備份、pid file |
| `/var/log/commerce/` | 檔案記錄（`logging.destination: file` 時） |

預設記錄走 journald：`journalctl -u commerce-api -f`。

## 升級

```bash
sudo commerce upgrade --release /tmp/commerce-1.1.0.tar.gz
```

流程：解壓到 `releases/1.1.0` → **用新版程式**執行 migration → 記下舊版路徑到
`/opt/commerce/previous` → 切換 `current` symlink → 重啟服務。

**migration 失敗時 symlink 不會被切換**，舊版繼續服務，指令以非零狀態結束並印出仍在使用的版本。

## 回退

```bash
sudo commerce rollback              # 切回 /opt/commerce/previous
sudo commerce rollback --to 1.0.0   # 切回指定版本
```

Migration 採 **Expand–Migrate–Contract**（ADR 0007）：

- `expand`：新增欄位／表，可為 null 或有預設值 —— 舊版程式看不到也不受影響
- `migrate`：回填資料，兩版程式都能運作
- `contract`：刪除欄位／表 —— **只能在確定不再回退舊版之後才發布**

因此只要還沒發布 `contract` 階段的 migration，回退舊版一定安全。
`commerce migrate --status` 會列出每個 migration 的階段。

## 備份與還原

```bash
sudo -u commerce commerce backup                       # 預設寫進 /var/lib/commerce/backups
sudo -u commerce commerce backup --out /mnt/nfs/x.dump
sudo -u commerce commerce restore /mnt/nfs/x.dump --yes # 會覆寫現有資料
```

備份是 `pg_dump --format=custom`，權限自動設為 0600。
`/etc/commerce/` 底下的設定與機密請另外備份 —— 它們不在資料庫裡。

## 端到端驗證

```bash
pnpm smoke:native
```

會在一個**乾淨的 Debian 容器**（先確認 PATH 上沒有 node）安裝 tarball、
執行 `commerce install`、`commerce start`、`commerce doctor`，再跑 35 項端到端檢查。
