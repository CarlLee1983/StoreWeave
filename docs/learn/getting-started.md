---
pageClass: architecture-page
---

# 第一次把 StoreWeave 跑起來

這一課會在你的電腦啟動一個 **Base 網站**，確認它可以回應請求，再取得下一課發布文章用的 API token。完成後，你會知道網站、API、Worker 與資料庫各自負責什麼，也能分辨「服務沒啟動」與「這個 Release 沒有這項功能」。

以下指令以倉庫根目錄、macOS／Linux 的 Bash 或 Zsh 為起點。這是依現有 Compose、CLI 與 smoke test 核對的操作流程；本頁編寫時沒有另建資料庫實跑整套教學。

## 先選對產品

Release 是一組一起建置、部署的能力。先決定你需要哪一組，再選啟動指令。

| 想完成的事 | 選哪個 Release | 實際入口 |
| --- | --- | --- |
| 公司網站、文章、最新消息，準備練習部落格 | **Base，本課使用** | 網站 `/`，內容操作用 REST API |
| 商品、購物車、訂單，以及商店營運後台 | Commerce | 根目錄 `compose.yaml`，後台 `/admin` |
| 住宿預訂 | Booking | 另見 [Booking 指南](../booking.md) |

Base 已經組入網站與內容能力。它目前沒有瀏覽器管理後台，`/admin` 回傳 404 是正確結果；它也沒有商品 API 或 MCP 端點。若你需要 Commerce，請沿用 [README 的快速開始](../../README.md#快速開始)，不要把 Commerce 的 `pnpm dev:api` 與本課 Base 資料庫混用。兩者應各用自己的資料庫。

依據：[Base Admin projection](../../packages/releases/base/src/admin.ts)、[Base smoke test](../../scripts/smoke-base.sh)、[產品分工](../reusable-application-base.md)。

## 1. 準備工具與乾淨的練習環境

你需要已下載的 StoreWeave 倉庫、正在執行的 Docker（含 Compose）、`curl` 與 `openssl`，以及可供建置下載套件與映像的網路。這條路徑的 Node 與 pnpm 在 Docker 內執行，不需要先安裝主機版 PostgreSQL。

先在倉庫根目錄確認：

```bash
docker info
docker compose version
curl --version
openssl version
```

**檢查點：** Docker 能連到 daemon，Compose 能顯示版本，其餘兩項能顯示版本資訊。若第一行失敗，先啟動 Docker，再繼續。

本課固定使用 `storeweave-learn` 作為 Compose project，與預設 Base 專案分開保存容器及 volume。請先確認電腦沒有同名練習環境，且 `localhost:3000` 沒被其他服務佔用。

接下來會建立本機資料庫與資料 volume，啟動時會套用 migration。只用於這個新建的練習環境，不要指向既有或正式資料庫。

## 2. 建置並啟動 Base

在**同一個終端機**準備練習用機密，再啟動服務：

```bash
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export STOREWEAVE_SIGNING_KEY_K1=$(openssl rand -base64 32)
export STOREWEAVE_PORT=3000
export STOREWEAVE_CONFIG_PATH=./deployments/storeweave.example.yaml
export STOREWEAVE_IMAGE=storeweave/base:learn

docker compose -p storeweave-learn -f compose.base.yaml up -d --build
docker compose -p storeweave-learn -f compose.base.yaml ps
```

這些值只留在目前 shell。完成本課前請保留這個終端機；若之後要繼續使用相同資料庫，請把同一組值保存在自己的受保護機密管理位置。**不要對已存在的練習 volume 重跑產生密碼的兩行**：產生新環境變數不會替 PostgreSQL 裡的舊密碼做輪替。

首次建置需要下載依賴。`up -d` 返回後，健康檢查可能仍在等待。需要看進度時執行：

```bash
docker compose -p storeweave-learn -f compose.base.yaml logs --tail=80 api worker
```

**預期結果：** `postgres` 與 `api` 最後呈現 healthy，`worker` 正在執行。API 日誌出現 `base api listening`。

這一條命令實際做了四件事：

1. 以 `STOREWEAVE_RELEASE=base` 建置 Base artifact。
2. PostgreSQL 保存網站資料；API 啟動前先執行 migration。
3. API 提供網站與 REST API，只將服務 port 綁在本機 `127.0.0.1`。
4. Worker 處理 Outbox 與背景工作；它與 API 共用這個網站的資料庫。

設定來自 [Base Compose](../../compose.base.yaml) 掛載的 [storeweave.example.yaml](../../deployments/storeweave.example.yaml)。設定檔的 `${STOREWEAVE_DATABASE_URL}` 由 Compose 注入；簽章金鑰透過 `secretRef` 引用，值不寫進 YAML。[Docker entrypoint](../../docker/entrypoint.sh) 負責等待資料庫、遷移，再啟動程式。

## 3. 確認網站真的能用

在瀏覽器開啟 <http://localhost:3000>。你應該看到 Base 網站與 `Base site` 站名。剛建立的資料庫沒有文章，這時不需要匯入 Commerce 商品示範資料。

再用終端機確認兩個健康端點：

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

**預期結果：** 兩個請求都是 HTTP 200。`live` 用來確認行程有回應，`ready` 用來確認目前可以服務請求。

最後試一次尚未帶身分的診斷請求：

```bash
curl -i http://localhost:3000/health/dependencies
```

**預期結果：** HTTP 401。這個端點需要權限；回 401 並不代表 PostgreSQL 斷線。下一步會用同一個 URL 看見帶身分之後的差別。

以上狀態碼與網站首頁的預期結果都對應 [Base smoke test](../../scripts/smoke-base.sh)。

## 4. 取得練習用 API 身分

人使用 Account 與 Session 登入；程式呼叫使用 API token。本課要從終端機發布文章，因此使用 token。它不是瀏覽器登入 cookie，也不會替 Base 加上一個 `/admin` 後台。術語見 [Account 與 Session](../../CONTEXT.md#account)。

用容器裡已建置的 Base CLI 簽發一把一天到期的練習 token：

```bash
docker compose -p storeweave-learn -f compose.base.yaml exec api \
  storeweave token:create --name blog-local --role admin --expires-in-days 1
```

**預期結果：** 出現「已簽發 API token」、名稱、角色、到期時間，以及秘密值。秘密只顯示這一次；不要貼進文件、版本庫或公開截圖。這把 `admin` token 是本機教學用的完整權限身分。

將剛顯示的秘密貼入下面的隱藏輸入，按 Enter：

```bash
printf '貼上剛產生的 token，然後按 Enter：'
read -r -s BLOG_TOKEN
printf '\n'
export BLOG_TOKEN

curl -i http://localhost:3000/health/dependencies \
  -H "Authorization: Bearer $BLOG_TOKEN"
```

**檢查點：** 現在應為 HTTP 200。同一個 API 能區分匿名請求與有權限的 Actor；接下來建立文章也會走這個授權邊界。

若要確認已簽發的名稱，可以執行下列命令；清單不會再顯示秘密：

```bash
docker compose -p storeweave-learn -f compose.base.yaml exec api storeweave token:list
```

命令名稱來自 [Base CLI projection](../../packages/releases/base/src/cli.ts)，簽發與到期選項見 [CLI 實作](../../tools/cli/src/main.ts)；認證機制見 [維運：後台登入與 API token](../operations.md#後台登入與-api-token)。

## 5. 做一個小練習，再進入文章發布

分別送出下面兩個請求，先預測回應再看結果：

```bash
curl -i http://localhost:3000/admin
curl -i http://localhost:3000/api/v1/products
```

兩個都應回 404。原因是你啟動的 Base 沒有組入這兩項 Commerce 介面。即使取得 admin token，也不會讓不存在的產品路由出現。

完成這三項就可以繼續：

- 首頁與 `/health/ready` 能回應。
- `/health/dependencies` 在匿名請求回 401，帶 token 回 200。
- 能說出 Base 為什麼沒有 `/admin`，以及 API 與 Worker 為什麼要同時啟動。

下一課：[用既有內容能力做一個部落格](../learn/build-a-blog.md)。沿用這裡的 Base 網站、終端機與 `BLOG_TOKEN`，實際建立草稿、發布文章，再從公開頁面確認結果。

## 卡住時，先對照這裡

| 現象 | 先檢查什麼 |
| --- | --- |
| Docker daemon 無法連線 | Docker 是否已啟動；先讓 `docker info` 通過 |
| `port is already allocated` | 停下佔用本機 3000 的其他練習服務。本課設定的 `publicUrl` 也是 3000，改 port 時要一起調整設定 |
| 缺少 `STOREWEAVE_SIGNING_KEY_K1` | 是否換了終端機、遺失第 2 步的環境變數；用原本同一組機密重新啟動 |
| PostgreSQL 密碼驗證失敗 | 是否對既有 volume 重新產生了 `POSTGRES_PASSWORD`；應恢復最初那一組值 |
| 首頁無法連線或 ready 尚未成功 | 查看 `ps` 與 `logs --tail=80 api worker`，先排除 migration 或資料庫錯誤 |
| 帶 token 仍是 401 | 是否只貼入秘密值、變數是否在目前 shell、token 是否已到期或被撤銷 |
| `/admin` 或 `/mcp` 是 404 | Base 的預期行為；確認你需要的是 Base 還是 Commerce |
| 沒收到驗證／重設密碼郵件 | 範本的 `mail.transport` 是 `disabled`；寄信需要另行設定 SMTP，與本課 token 流程無關 |

不要把 `docker compose config` 的完整輸出貼到公開問題回報，它可能包含已解析的機密值。

## 練習完成後

若還要繼續部落格教學，先保留服務與 token。全部練習結束後，撤銷 token，再停止服務：

```bash
docker compose -p storeweave-learn -f compose.base.yaml exec api \
  storeweave token:revoke blog-local
unset BLOG_TOKEN
docker compose -p storeweave-learn -f compose.base.yaml down
```

`down` 保留資料 volume；再次啟動要沿用原來的資料庫密碼與簽章金鑰。這裡不加 `-v`，因此文章與上傳物件不會隨容器停止而刪除。

要開始修改程式時，主機需要 Node.js 22 以上與專案釘選的 `pnpm@12.0.0`。套件、開發與驗證命令以 [README](../../README.md#快速開始) 與 [package.json](../../package.json) 為準；程式改動的完成門檻是 `make verify`，包括需要 Docker 的 PostgreSQL 整合測試。原生建置使用 `STOREWEAVE_RELEASE=base pnpm build` 選取 Base；只設定該變數後執行 Commerce 預設的開發指令，不能替代 Release 建置選擇。
