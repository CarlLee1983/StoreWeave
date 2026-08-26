# 維運

## `commerce` CLI

同一支指令在 Docker 容器內、原生主機上、以及開發機（`pnpm commerce ...`）行為一致，
因為三者走的是同一個 `bootstrap()` 與同一份 Runtime。

**指令的輸出走 stdout，runtime 的日誌走 stderr**，因此 `--json` 那幾支可以直接接管線：
`commerce extension:list --json | jq '.items[].subscribedEvents'`。日誌沒有被關掉，
人在終端機看到的還是一樣。設定寫 `logging.destination: file` 的部署不受影響。
（開發機上多一層 pnpm，它自己會 echo 一行 `$ tsx ...` 到 stdout，要接管線得加 `--silent`。）

| 指令 | 用途 |
| --- | --- |
| `commerce install` | 建立目錄、放置設定範本、驗證設定 schema、套用 migration |
| `commerce start` / `stop` / `restart` | 啟停 API 與 Worker（有 systemd 用 systemd，否則退回 pid file） |
| `commerce status` | 顯示兩個服務的狀態與管理方式 |
| `commerce doctor [--json]` | 完整安裝健檢，有 fail 時以非零狀態結束 |
| `commerce migrate [--status]` | 套用或檢視 migration（含 expand/migrate/contract 階段） |
| `commerce backup [--out FILE]` | `pg_dump --format=custom`，權限 0600 |
| `commerce restore FILE --yes` | `pg_restore --clean --if-exists`（會覆寫現有資料） |
| `commerce upgrade --release TARBALL` | 解壓新版 → 用新版跑 migration → 切換 symlink → 重啟 |
| `commerce rollback [--to VERSION]` | 切回上一版或指定版本並重啟 |
| `commerce user:create --email E --name N [--role admin]` | 建立後台操作者帳號；密碼由 `COMMERCE_USER_PASSWORD` 環境變數提供 |
| `commerce extension:list [--json]` | 列出已啟用的 Extension、權限、事件、Command、Query、Provider、MCP 工具 |

`commerce doctor` 檢查項目：

```
application version         release / platform / node 版本
configuration schema        commerce.yaml 是否通過驗證
postgresql connection       連線與延遲
migration status            已套用 / 待套用（含階段）
worker                      最後一次心跳距今多久
outbox backlog              pending / relayed / dead
job queue backlog           pending / running / completed / dead
storage directory           /var/lib/commerce 等目錄是否可讀寫
extension compatibility     每個 Extension 的 platformVersion 是否相容
secret present              每個必要機密是否存在（只檢查存在，不印出值）
provider:<kind>:<id>        每個啟用 Provider 的 health；不健康會讓 doctor fail
extension status: mcp       公開了幾個工具
extension status: demo-erp  投遞成功 / 待處理 / 失敗筆數
service: commerce-api/worker  行程是否在跑
```

## 後台登入與 API token

兩條驗證路徑並存，因為人與機器是不同的東西：

- **人用帳號登入**。第一個管理員用 CLI 產生，密碼走環境變數而不是命令列參數，
  否則會留在 shell history 與 `ps` 輸出裡：

  ```bash
  COMMERCE_USER_PASSWORD='一組夠長的密碼' \
    sudo -u commerce commerce user:create --email ops@example.com --name 維運 --role admin
  ```

  之後在管理後台用這組帳密登入。session 是 httpOnly cookie，12 小時到期，
  audit log 會記成 `user:<uuid>`，查得出是誰動的。

  cookie 的名字看 `http.publicUrl`：能發 Secure（https，或非本機的 hostname）時
  帶 `__Host-` 前綴，本機以 http 開發時是裸名（ADR 0023）。**改動 `publicUrl` 而
  跨過這條界線會讓既有的 session 與訪客購物車全部失效一次**——大家要重新登入，
  這是預期行為，不是故障。

- **機器用靜態 token**。`commerce.yaml` 的 `auth.tokens` 那組 bearer token 維持原樣，
  給 MCP 客戶端與 ERP 這類非瀏覽器呼叫端使用。它們不套用 CSRF 檢查，
  但也因此**沒有到期、不能個別撤銷**——`COMMERCE_ADMIN_TOKEN` 等於一把萬能鑰匙，
  正式環境務必換成隨機值並限制知悉範圍。

  **沒有任何自動檢查會擋下你**：`commerce doctor` 只確認 secret「有沒有設」
  （`packages/platform/kernel/src/health.ts` 的 `secret present`），不看它的值，
  所以帶著 `dev-admin-token-change-me-please` 上線是通得過的。換掉它是人的責任。

尚未實作的部分：密碼重設、後台的帳號停用介面、登入失敗鎖定、二階段驗證。
需要停用某個帳號時，目前只能直接改資料庫的 `platform_users.status`。

## 健康端點

| 端點 | 語意 | 狀態碼 |
| --- | --- | --- |
| `/health/live` | 行程還活著 | 恆 200 |
| `/health/ready` | 可以接流量：資料庫連得上且沒有待套用的 migration | 200 / 503 |
| `/health/dependencies` | 資料庫、Outbox、佇列、Worker 心跳、各 Provider、各 Extension | 200 / 503（需 bearer token） |

`/health/live` 與 `/health/ready` 不需要 API token，可直接給負載平衡器使用。
`/health/dependencies` 是含有 provider 錯誤訊息、佇列深度與 worker id 的維運視圖，必須使用具權限的
bearer token；監控應以安全的憑證或內網呼叫它。它與 `commerce doctor` 共用依賴檢查邏輯，但 doctor
另有安裝、設定、目錄與 secret 檢查。

啟用 ECPay 時，`provider:payment:ecpay` 會標示離線設定已驗證、外部連通性與 callback delivery 仍需 UAT：
它只驗證離線設定與 extension health，不會探測 ECPay 或證明 callback 可達。正式切換與 callback 失敗處置見
[ECPay Checkout 上線 Runbook](runbooks/ecpay-release.md)。

## 監控建議

| 指標 | 來源 | 門檻建議 |
| --- | --- | --- |
| Outbox 積壓 | `/health/dependencies` 的 `outbox` | pending > 500 轉 warn、dead > 0 直接 fail（門檻寫在 `health.ts`） |
| 工作佇列 dead | 同上的 `jobs` | dead > 0 就告警 |
| Worker 心跳 | 同上的 `worker` | 超過 60 秒為 warn、300 秒為 fail |
| 待套用 migration | `/health/ready` | 部署後應為 0 |

## 記錄

- 預設 `logging.destination: stdout`，JSON 格式。Docker 交給 log driver，systemd 交給 journald。
- 改成 `file` 時寫入 `logging.file`（預設 `/var/log/commerce/commerce.log`），目錄會自動建立。
- 所有結構化欄位在寫入前都會經過機密遮蔽：欄位名稱含 `password`、`secret`、`token`、
  `apikey`、`authorization`、`credential`、`privatekey` 的值一律變成 `[redacted]`。
  Audit Log 走同一層遮蔽。

## Audit Log

敏感操作會寫進 `platform_audit_log`，與業務寫入在**同一個交易** ——
不會出現「做了但沒紀錄」。

動作名稱由每支 command 自己宣告，權威清單就是程式碼：
`grep -rn "audit: {" packages/commerce/*/src/commands.ts` 撈得到全部。
目前橫跨 catalog、inventory、order、cart、coupon、promotion、loyalty、customer、
shipping、refund、rma、invoice、notification 與 content 十四個模組，四十餘個動作。
這裡不再抄一份——抄過的那一份停在九個動作，落後了三輪。

每筆包含 actor id 與類型、extension id（若由 Extension 觸發）、資源類型與 id、
correlation id，以及經過遮蔽的請求摘要。

## Idempotency

所有寫入操作都支援 `Idempotency-Key` header，其中三十餘支是**必填**——
凡是會產生錢、庫存或外部效果的 command 都在內。同樣不在這裡列清單，
`grep -rn "idempotency: 'required'" packages/commerce/*/src/commands.ts` 是權威來源；
`GET /api/v1/meta/commands` 也會回報每一支的 idempotency 要求。

- 相同 key + 相同內容 → 回傳第一次的結果，不重複執行
- 相同 key + 不同內容 → `422 IDEMPOTENCY_MISMATCH`
- 前一個請求還在處理中 → `409 IDEMPOTENCY_IN_PROGRESS`
- 失敗的請求不會佔用 key（交易回滾時 idempotency 紀錄一併回滾），可以直接重試

## 常見狀況

**Outbox 積壓上升** — 先看 `commerce status` 確認 Worker 在跑，
再看 `commerce doctor` 的 job queue：如果 dead 數字在長，表示某個 Extension 一直失敗，
用 `commerce extension:list` 找出對應的 Extension 再看它的 log。

**ERP 投遞卡住** — 查 `GET /api/v1/extensions/demo-erp/queries/ext.demo-erp.listDeliveries`
（或後台的 ERP 分頁），每筆有 `status`、`attempts`、`lastError`、`remoteId`。
確認遠端恢復後用人工重送：
`POST /api/v1/extensions/demo-erp/commands/ext.demo-erp.resendOrder`。
遠端以 `reference` 去重，重送不會產生第二張單據。

**要知道哪一支慢** — 每一次 Command / Query 執行完都會寫一行帶 `latencyMs` 的日誌（工單 53）：

| | 一般 | 達到 500ms |
| --- | --- | --- |
| Command 成功 | `info` | `warn`（`slow command executed`） |
| Query 成功 | `debug` | `warn`（`slow query executed`） |
| 失敗 4xx | `debug` | `warn` |
| 失敗 5xx | `error` | `error` |

Query 成功停在 `debug`，是因為前台每渲染一次就會打好幾支，逐次 `info` 會把日誌淹掉；
要看全部的話把 `logging.level` 調到 `debug`。慢的那幾筆在預設 level 就看得見：

```bash
journalctl -u commerce-api | grep '"msg":"slow ' | tail -50
docker compose logs api | grep '"msg":"slow '
```

那一行帶 `command` 或 `query` 的名字、`latencyMs`、`correlationId` 與 `channel`，
失敗的還多一個 `code`，冪等重放的多一個 `replayed: true`。
5xx 走 `error` 是為了與 HTTP 那層的 exception filter 對齊——Bus 是所有通道的共同咽喉，
以 `level >= error` 設告警的部署不該只抓到走 REST 的那一半而漏掉 worker 與 CLI。
同一次請求在 Bus 與 filter 各留一行（前者有耗時、後者有訊息與細節），靠 `correlationId` 串起來。

**升級後出現沒看過的 400 `VALIDATION_ERROR`** — 從這一版起，Command 與 Query 的輸入
一律拒絕未知欄位（ADR 0024）。過去送了多餘欄位而被安靜忽略的請求，現在會被擋下來。
回應的 `error.details` 會指出是哪一個鍵（同一份也寫進 `logger.warn`）；正確的處置是把
那個鍵從客戶端拿掉，而不是放寬 schema——它本來就沒有做到送出者以為它做到的事。
Extension 自己的輸入（`ext.*`）同樣拒絕未知欄位。差別只在 `GET /api/v1/extensions/.../queries/...`
的 query string：橋接會先把該支 Query 沒宣告的鍵挑掉，因此 `?_t=` 這類 cache-buster 不會變成 400。
Extension Command 的 JSON body 不挑，多送的鍵一律 400。

**升級後想回退** — `commerce rollback`。若該版本已經套用過 `contract` 階段的 migration，
舊版程式無法讀取新 schema，此時只能還原備份。
