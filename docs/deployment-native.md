# 原生 Linux 部署（Ubuntu / Debian x86-64）

**正式主機不需要安裝 Node.js、pnpm、TypeScript 或任何編譯工具。**
Release tarball 內含固定版本的 Node runtime 與已編譯的 API／worker／CLI／seed。
Commerce 另含 Admin、Theme 資產與選定的商務模組；Base 不攜帶 Commerce runtime 或資產。

## 產生 Release

在建置機（macOS 或 Linux 都可以）：

```bash
pnpm install
pnpm build:release
```

產出：

```
release/commerce-<version>.tar.gz        約 48 MB（含 Node runtime）
release/commerce-release-media_<version>_amd64.deb     建置機有 dpkg-deb 時才會產生
```

以 `STOREWEAVE_RELEASE=base` 選 Base，預設為 `commerce`。可設定 `STOREWEAVE_RELEASE_VERSION`、
`STOREWEAVE_NODE_VERSION`（預設 22.17.1）、`STOREWEAVE_TARGET_ARCH`（預設 x64），
以及全新的 `STOREWEAVE_BUILD_DIR`／`STOREWEAVE_RELEASE_DIR`。同名輸出已存在時拒絕覆寫。
Commerce 的 `COMMERCE_RELEASE_VERSION`／`COMMERCE_NODE_VERSION`／`COMMERCE_TARGET_ARCH` 仍相容。

## 安裝

```bash
scp release/commerce-1.0.0.tar.gz server:/tmp/
ssh server
sudo apt-get install -y postgresql-client       # 升級／備份／還原需要
work=$(sudo mktemp -d)
sudo tar -xzf /tmp/commerce-1.0.0.tar.gz -C "$work" --strip-components=1
sudo "$work/scripts/install.sh"
sudo rm -rf -- "$work"
```

`install.sh` 只用於首次安裝；已有 `current`（含失效 symlink）時會拒絕，既有安裝請使用升級流程。
Native 安裝器與 CLI `upgrade`／`rollback` 共用 `/opt/<name>/.transition.lock`，需要 Linux `flock`（util-linux）。
同時執行時會拒絕第二個操作；不要刪除鎖檔，程序退出會釋放核心鎖。
CLI 持鎖後會準備擁有者私有的 `.transitions` 目錄，並同步其目錄項目；既有不安全權限或 symlink 會被拒絕。
安裝根目錄必須屬於執行者，且不可讓群組或其他使用者寫入，也不可是 symlink。CLI 保留鎖的檔案描述符；升級的 migration 子程序繼承該鎖，即使 CLI 被終止，仍須等 migration 結束才能取得鎖。

首次安裝會做這些事：

1. 建立系統使用者／群組 `commerce`
2. 建立目錄：`/opt/commerce/releases`、`/etc/commerce`、`/var/lib/commerce`、`/var/log/commerce`
3. 把程式安裝到 `/opt/commerce/releases/<version>`，並把 `/opt/commerce/current` 指過去
4. 建立 `/usr/local/bin/commerce`（指向 `current/bin/commerce` 的 symlink）
5. 放置 `commerce.yaml` 與 `commerce.env` 範本（`commerce.env` 權限 0640、擁有者 root:commerce）
6. 安裝並 enable systemd unit（環境沒有 systemd 時會略過並提示）

`.deb` 只交付安裝媒體，不建立使用者、設定、systemd unit 或切換 `current`。例如：

```bash
sudo dpkg -i commerce-release-media_1.0.0_amd64.deb
media=/usr/lib/storeweave-release-media/commerce/1.0.0/commerce-1.0.0.tar.gz
work=$(sudo mktemp -d)
sudo tar -xzf "$media" -C "$work"
sudo "$work/commerce-1.0.0/scripts/install.sh"
sudo rm -rf -- "$work"
```

最後一步只適用全新安裝，執行上列相同的 native 安裝流程。既有部署使用下方升級程序，
把此 tarball 傳給 `upgrade --release`；B01 必須從解開的候選版本執行明確的
`--from-legacy-b01` bridge。Base 對應套件為 `storeweave-release-media`，媒體路徑名稱為 `storeweave`。

重新 configure、更新或移除 `.deb` 只管理媒體，已安裝的程式、設定與資料由原本的安裝／CLI
流程管理。需要保存候選媒體時，先複製 tarball 到獨立備存目錄；更新或移除套件會移除舊媒體。
套件不代為安裝 PostgreSQL client，請依下方升級／備份需求準備 `pg_dump` 與 `pg_restore`；連線到本專案的 PostgreSQL 17
時，兩者必須是 17 或相容的較新版本，不能使用較舊的 `pg_dump`。

媒體套件使用獨立的 `commerce-release-media` 名稱，可與舊 `commerce` 套件共存。
它不接管舊套件的正式安裝檔案；不要移除仍持有執行中或還原版本檔案的舊套件。

## 設定

編輯 `/etc/commerce/commerce.env`（0640，root:commerce）：

```
DATABASE_URL=postgres://commerce:...@127.0.0.1:5432/commerce
COMMERCE_PUBLIC_URL=https://shop.example.com
COMMERCE_SIGNING_KEY_K1=<openssl rand -base64 32>
DEMO_ERP_API_KEY=<客戶提供>
```

API token 不寫在設定或 env：安裝完成後用 `commerce token:create --name <名稱> --role <角色>`
簽發，秘密只顯示一次（ADR 0043）。

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
| `/opt/commerce/releases/<version>/` | 程式：`app/`、`runtime/`、`admin/`、`bin/`、`config/`、`systemd/`、`scripts/`、`theme-assets/`，以及 `VERSION` 與 `build-info.json` |
| `/opt/commerce/current` | 指向目前版本的 symlink |
| `/opt/commerce/.transitions` | 私有的配對快照與升級／還原日誌 |
| `/etc/commerce/commerce.yaml` | 設定 |
| `/etc/commerce/commerce.env` | 機密（0640，root:commerce） |
| `/var/lib/commerce/` | 持久資料、備份、pid file |

**`theme-assets/` 的位置是有相依的**：它與 `app/` 同層放在 release 根目錄，因為
`apps/api/src/theme-assets.ts` 就是往 `<release>/../theme-assets` 找。前台的
`/storefront-assets/` 靠它服務品牌照片。改動 release 佈局時要一起改那支解析器，
否則照片會靜默消失而不是報錯。要放到別處，用 `COMMERCE_THEME_ASSETS_DIR` 明確指定。
| `/var/log/commerce/` | 檔案記錄（`logging.destination: file` 時） |

預設記錄走 journald：`journalctl -u commerce-api -f`。

`/var/lib/commerce/storage` 是 local object storage 的預設根目錄，必須由 `commerce` 使用者可讀寫且隨
release 保留。多台 API 主機不能使用彼此獨立的 local storage；改用私有 S3 相容 bucket，並把憑證寫入
`commerce.env`、在 YAML 只引用其 secret 名稱。

## 升級

候選 tarball 必須只有一個與 RELEASE／VERSION 相符的根目錄，且 build manifest 摘要與必要檔案完整。
安裝器拒絕 links、特殊節點、setuid/setgid 與不安全路徑；CLI 先在私有暫存目錄解壓、驗證，再原子搬移至尚不存在的版本目錄。
固定上限為壓縮檔 256 MiB、展開內容 1 GiB、10,000 個項目與單一路徑 1,024 UTF-8 bytes。
清單檢查每次最多 60 秒，解壓最多 300 秒；超限即失敗。原生目錄安裝也會核對展開內容與項目上限。
搬移失敗可能保留空的版本 reservation，需確認沒有其他安裝作業後再處理；不會自動刪除可能屬於其他程序的目錄。

```bash
sudo commerce upgrade --release /tmp/commerce-1.1.0.tar.gz --external-writers-stopped --no-restart
sudo commerce upgrade --resume /path/to/upgrade.json --external-writers-stopped --no-restart
# 若快照已發布、但程序在 journal 寫入前中止：
sudo commerce upgrade --snapshot /path/to/snapshot --checksum sha256:RECORDED_DIGEST --external-writers-stopped --no-restart
```

流程：驗證候選 Release → 停止管理中的服務 → 保存來源資料庫與程式的配對快照 → 持久寫入 upgrade journal
→ 在驗證過的私有程式副本執行 migration → 核對候選版本已啟用且無 pending migration → 原子切換 `current`。

每次執行都必須確認外部寫入者已停止；`--no-restart` 仍會停止舊程序。Migration 失敗時服務保持停止，
保留快照、日誌與目前 `current`。使用輸出的 upgrade journal 可向前重試同一候選版本；重試會核對來源
資料庫的端點、cluster 與 OID，不會自動還原或改選其他候選版本。
快照路徑、checksum 與 journal 路徑會輸出，請保存這些復原資訊。
若已發布快照但尚無 journal，使用 `--snapshot` 與保存的 `--checksum` 可建立新的升級日誌，
繼續該快照綁定的候選版本；不會重新取代快照或刪除中止的日誌目錄。

### B01 0.1.0 明確轉接

先停止所有外部寫入者，確認來源為保留的 Commerce 0.1.0。使用候選版本自己的 CLI，
不能從舊 `current` 執行新版 bridge。下列以媒體包的 1.1.0 候選為例：

```bash
media=/usr/lib/storeweave-release-media/commerce/1.1.0/commerce-1.1.0.tar.gz
work=$(sudo mktemp -d)
sudo tar -xzf "$media" -C "$work"
sudo "$work/commerce-1.1.0/bin/commerce" upgrade --from-legacy-b01 \
  --release "$media" --catalog legacy-commerce-0.1.0-pre-b02 \
  --evidence '變更紀錄編號與來源核對紀錄' --external-writers-stopped --no-restart
```

將 evidence 改成此次維護的實際紀錄。保存輸出的 raw safety、checksum、bridge journal
與採納後 paired snapshot。失敗時保留候選解壓目錄，使用同一個候選 CLI 續跑：

```bash
sudo "$work/commerce-1.1.0/bin/commerce" upgrade --from-legacy-b01 \
  --resume /opt/commerce/.transitions/UUID/bridge.json --external-writers-stopped --no-restart
```

續跑不另傳 catalog／evidence，使用 journal 的原紀錄。完成後可刪除此私有解壓目錄：
`sudo rm -rf -- "$work"`；已安裝候選與 journal 保留在 `/opt/commerce`。
採納只建立固定 catalog 基準，不能證明舊日 SQL 或 runtime bytes；兩個 historical verification flags 保持 false。

## 回退

回退使用配對快照及其記錄的 checksum，不再接受 `--to` 或只切換 symlink。
現代 Release 的 upgrade 會先保存配對快照；B01 bridge 另保留採納 metadata 前的 raw safety snapshot。

```bash
sudo commerce rollback --snapshot /path/to/snapshot --checksum sha256:RECORDED_DIGEST \
  --yes --external-writers-stopped --no-restart
sudo commerce rollback --resume /path/to/journal.json \
  --yes --external-writers-stopped --no-restart
```

B01 還原須明確指定 `--to-legacy-b01`，並使用原候選版本自己的 CLI（即使 `current` 已切回 B01）：

```bash
candidate=/opt/commerce/releases/1.1.0/bin/commerce
# 採納 metadata 後的 paired snapshot：
sudo "$candidate" rollback --to-legacy-b01 --snapshot /path/to/snapshot \
  --checksum sha256:RECORDED_DIGEST --yes --external-writers-stopped --no-restart
# 採納前的 raw safety；適用 paired snapshot 尚未發布就失敗：
sudo "$candidate" rollback --to-legacy-b01 --safety /path/to/safety \
  --checksum sha256:RECORDED_DIGEST --yes --external-writers-stopped --no-restart
# 還原 journal 已有可恢復的階段時：
sudo "$candidate" rollback --to-legacy-b01 --resume /path/to/journal.json \
  --yes --external-writers-stopped --no-restart
```

從本次保存的輸出選取相符的路徑與 checksum，不要依檔名推測。Raw 還原回到舊三欄 ledger、
沒有 B02 metadata；paired 還原重現當時採納的 metadata。兩者都是整個 DB 還原，
快照後寫入只留在 quarantine，不合併到還原的來源資料庫。

每次執行前停止外部寫入者，並維持停止直到完成。CLI 會停止管理中的服務，在新的 scratch 資料庫還原，
核對資料庫記錄與保留版本的 CLI，持久記錄切換意圖後才原子切換資料庫名稱，最後切回來源程式。
原資料庫保留為 journal 記錄的 quarantine 名稱；指令不會自動刪除它。
`--maintenance-database` 預設為 `postgres`，必須不同於 live 資料庫，且目前 PG17 還原需要 maintenance superuser。

失敗後服務保持停止。`--resume` 只接受目前安裝 `.transitions/<UUID>/` 內、屬於執行者的私有日誌；不能指向其他目錄。
已有切換意圖的 journal 會透過實際 OID 辨認是否提交，再繼續驗證；
尚未完成 scratch 還原的 journal 會拒絕續跑，保留該次嘗試並另建 scratch。
若重啟服務途中失敗，CLI 只清理本次新啟動的程序／原先未執行的 systemd unit，保留啟動前已在跑的服務；已提交的資料庫、來源 `current` 與 quarantine 保持不變。
Migration 的 expand/migrate/contract 階段不足以證明舊程式能安全讀取目前資料庫。

## 備份與還原

```bash
sudo -u commerce commerce backup                       # 預設寫進 /var/lib/commerce/backups
sudo -u commerce commerce backup --out /mnt/nfs/x.dump
sudo -u commerce commerce restore /mnt/nfs/x.dump --yes # 會覆寫現有資料
```

備份是保留物件擁有者／ACL 的 `pg_dump --format=custom`。先以 0600 寫入私有暫存目錄，
通過 `pg_restore --list` 檢查並同步檔案後才發布；目的檔案已存在時拒絕覆寫，失敗只清理本次暫存。
原始 `restore` 指令仍使用 `--no-owner` 與 `--clean`，不能視為完整版本回退：備份後新增的物件不會因此自動移除。

Native PostgreSQL 工具使用短期私有 `PGPASSFILE`，不把連線密碼或應用程式的 secret 環境傳進子程序。
既有 password file 必須是無 group／other 權限的 regular file，不接受 symlink，且不超過 1 MiB。
Query password 的加號需寫成 `%2B`，空白寫成 `%20`；拒絕有歧義的原始 `+`。
備份前會檢查 `pg_dump` 與 `pg_restore` 均可用；離線 `--list` 驗證不接收資料庫連線或憑證。
連線端點／使用者放在 URI authority，database 放在 path；拒絕 query 的 host／hostaddr／port／user／dbname 覆寫、
service／passfile／sslpassword 與明確空密碼，避免憑證被送至不同的連線目標。
`/etc/commerce/` 底下的設定與機密請另外備份 —— 它們不在資料庫裡。

### 完整資料與媒體備份

單純 `backup` 是相容用的資料庫 dump；它不包含 local storage 或 S3 中的物件。要取得可重建媒體與其他
storage 物件的備份，先停止 **API、Worker 與所有外部寫入者**，再明確確認這個事實：

```bash
sudo systemctl stop commerce-api commerce-worker
sudo -u commerce commerce backup --include-media --external-writers-stopped \
  --out /mnt/backup/commerce-$(date +%F).bundle
```

完整 bundle 是 private directory，內含已由 `pg_restore --list` 驗過的 `database.dump`、嚴格 manifest，
以及以 SHA-256 命名的物件副本。每一個 database `ready` object 的 namespace、immutable storage key、
大小與 hash 都要與實際位元組相符，任一不符就不發布 bundle。它不記錄 bucket URL、S3 憑證或 local 路徑，
所以可在受支援的 local／S3 adapter 間復原。

完整還原也必須保持服務停止。指令先驗證整份 bundle，將 DB 還原到 scratch database，並在那個資料庫
驗證 ready-object 集合、重建或驗證同 key 的物件；所有驗證通過後才以 ADR 0037 的 journaled cutover
切換 DB，原 DB 會保留為 quarantine。若物件已存在但 hash 不同，指令拒絕覆寫並保持服務停止，讓操作者調查。它不刪除
bucket／storage root 中 manifest 沒列出的 key——那可能屬於共享 bucket 的別的部署；已還原的資料庫不會參照
它們。

```bash
sudo -u commerce commerce restore --bundle /mnt/backup/commerce-2026-09-11.bundle \
  --maintenance-database postgres --yes --external-writers-stopped
sudo -u commerce commerce doctor
sudo systemctl start commerce-api commerce-worker
```

完整 bundle 還原不是 ADR 0037 的 release rollback：它不切換到另一個 release，但使用相同 scratch／journal
cutover 邊界，且不刪除 quarantine database。
完整 recovery journal 位於 `/var/lib/commerce/.transitions/<UUID>/journal.json`；若程序在已建立 scratch 後中斷，
保留它供診斷，只有已完成 database restore 的 journal 才能續跑。續跑仍要給同一個 bundle，讓 CLI 重新核對
manifest、dump 與 storage catalogue：

```bash
sudo -u commerce commerce restore --bundle /mnt/backup/commerce-2026-09-11.bundle \
  --resume /var/lib/commerce/.transitions/<UUID>/journal.json \
  --maintenance-database postgres --yes --external-writers-stopped
```

完整 restore 比對的是 selected release 的 id、version 與 build-manifest checksum，不假設 Docker 的 `dist/`
等同 native release archive；來源 PostgreSQL system identifier 與 OID 是 provenance，不是乾淨目標 cluster 的前提。
跨版升級／回退仍走前面的 `upgrade`／`rollback` 流程；在 contract migration 前，先保存一份完整 bundle 作為
資料與媒體的獨立復原點。備份中的 jobs 是資料庫列，會保留 id、payload、dedupe 與狀態；只在 matching release
通過 `doctor` 後才重新啟動 Worker。

## 端到端驗證

```bash
pnpm smoke:native
```

會在一個**乾淨的 Debian 容器**（先確認 PATH 上沒有 node）安裝 tarball、
執行 `commerce install`、`commerce start`、`commerce doctor`，再跑 `scripts/smoke.sh` 的全部端到端檢查（項數以那支腳本為準）。
