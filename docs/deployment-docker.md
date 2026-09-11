# Docker 部署

Docker 與原生 Linux 使用**同一份** Application Artifact（`dist/`）與**同一份**設定格式
（`commerce.yaml` + 環境變數機密）。差別只有「誰負責重啟」。

## 一條指令啟動

```bash
docker compose up -d
```

會啟動三個服務：

| 服務 | 內容 |
| --- | --- |
| `postgres` | PostgreSQL 17，資料存在具名 volume |
| `api` | Storefront SSR、REST API、Admin 靜態資源、MCP 端點；啟動時自動套用 migration |
| `worker` | Outbox 轉送與背景工作 |

啟動後：

- Storefront `http://localhost:3000`
- 管理後台 `http://localhost:3000/admin`
- MCP 端點 `http://localhost:3000/mcp`
- 健康檢查 `/health/live`、`/health/ready`、`/health/dependencies`、`/health/metrics`

## 設定與機密

`compose.yaml` 把 `deployments/example-store/commerce.yaml` 唯讀掛載到 `/etc/commerce/commerce.yaml`。
要換成自己的店，改掛自己的檔案即可：

```yaml
volumes:
  - ./deployments/my-store/commerce.yaml:/etc/commerce/commerce.yaml:ro
```

機密一律走環境變數，不寫進 `commerce.yaml`。建立 `.env`（已在 `.gitignore` 內）：

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# 身分連結與下載連結的簽章金鑰；沒有它的部署不會啟動（ADR 0042）
COMMERCE_SIGNING_KEY_K1=$(openssl rand -base64 32)
DEMO_ERP_API_KEY=...
COMMERCE_PUBLIC_URL=https://shop.example.com
# 對外 port，預設 3000
COMMERCE_PORT=3000
```

Theme 隨附的編輯照片由映像內建、前台以 `/storefront-assets/` 提供，不需要另外設定。
要換成別的目錄才需要 `COMMERCE_THEME_ASSETS_DIR`——它的解析順序與相依寫在
[deployment-native.md 的目錄佈局](deployment-native.md#目錄佈局)。

上傳物件預設放在 `commerce-data` volume 的 `/var/lib/commerce/storage`，因此 image 重建與 release
替換不會遺失它們。多節點 API 不可共用各自的 local disk；請設定私有的 S3 相容 storage backend，並把
access key / secret 放在 `.env` 對應的 secret provider。不要把 bucket 設成 public，公開與短效 URL
仍由應用程式的 storage 路由驗證。

`commerce.yaml` 用 `${VAR}` 或 `${VAR:-預設值}` 參照它們。缺少必要變數會在啟動時
列出名稱並直接失敗，不會用空字串跑下去。

## 常用操作

```bash
docker compose exec api commerce doctor          # 完整健康檢查
docker compose exec api commerce extension:list  # 已啟用的 Extension 與其契約
docker compose exec api commerce migrate --status
docker compose logs -f api worker
docker compose exec api commerce backup          # 備份寫進 commerce-data volume
```

`backup` 預設只有 PostgreSQL dump。要做含 local storage／S3 物件的完整備份，必須先停下所有 writer；
不要在仍在服務流量的 `api` container 內執行它：

```bash
docker compose stop api worker
docker compose run --rm api commerce backup --include-media --external-writers-stopped \
  --out /var/lib/commerce/backups/commerce-full.bundle
# 將 commerce-data volume 內的 bundle 匯出至受保護的外部備份位置後：
docker compose up -d
```

隨附 image 安裝 PostgreSQL 17 client，和 Compose 的 PostgreSQL 17 server 配對；請勿以較舊的 `pg_dump` 替換它。

完整 bundle 驗證每一筆 ready object 的 SHA-256，並可用 `commerce restore --bundle … --maintenance-database postgres --yes
--external-writers-stopped` 在 scratch DB 驗證後切換資料庫與物件。還原前後都保持 `api`／`worker` 停止；完整操作、共享 S3
bucket 不自動刪除策略與 release rollback 的差異見[原生部署的完整備份章節](deployment-native.md#完整資料與媒體備份)。Docker 的
`/opt/commerce/current` 是 immutable raw `dist`，所以完整 recovery 只核對 selected release identity，journal 寫入
持久的 `commerce-data` volume。中斷後以同一 bundle 加 `--resume /var/lib/commerce/.transitions/<UUID>/journal.json` 續跑。

`COMMERCE_AUTO_MIGRATE=false` 可以關掉 API 啟動時的自動 migration，
改成部署流程裡明確執行 `docker compose run --rm api migrate`。

## 升級

```bash
git pull
docker compose build
docker compose up -d
```

`api` 容器啟動時會套用新的 migration（`expand` / `migrate` 階段向後相容，
舊版容器仍可運作，見 ADR 0007）。要回退就用舊的 image tag 重新 `up -d`。

## 端到端驗證

```bash
pnpm smoke:docker
```

會建置映像、啟動完整環境、在容器內跑 `commerce doctor` 與 `commerce extension:list`，
再從主機跑 `scripts/smoke.sh` 的全部端到端檢查（三條垂直流程 + MCP + 契約自省），最後收乾淨。

## 正式環境注意事項

- `api` 服務前面放反向代理處理 TLS，並把 `http.trustProxy` 設為 `true`。
- `postgres` 服務沒有對外開 port；要外接受管資料庫時把它從 compose 移除，
  改設 `DATABASE_URL` 指向該資料庫，並把 `database.ssl` 設為 `true`。
- 映像以非 root 的 `commerce` 使用者執行，`tini` 負責 signal 轉發。
- 記錄走 stdout（JSON），交給 Docker 的 log driver 收集。
