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
| `commerce migrate --status --json` | 輸出 applied／pending／releaseCurrent；不執行 domain SQL、extension setup 或 release 啟用 |
| `commerce backup [--out FILE]` | 私有暫存 dump 驗證後原子發布，權限 0600；拒絕覆寫既有檔案 |
| `commerce backup --include-media --external-writers-stopped [--out DIR]` | 建立 DB dump 加上全部 ready storage 物件的私有、內容雜湊驗證 bundle |
| `commerce restore FILE --yes` | `pg_restore --clean --if-exists`（只還原資料庫，會覆寫現有資料） |
| `commerce restore --bundle DIR --maintenance-database postgres --yes --external-writers-stopped` | 在 scratch DB 驗證完整 bundle 與物件後，以 journaled cutover 切換；保留舊 DB 作 quarantine |
| `commerce restore --bundle DIR --resume JOURNAL --maintenance-database postgres --yes --external-writers-stopped` | 重新驗證同一 bundle 後，續跑 data-dir 私有的完整 recovery journal |
| `commerce restore --list-recoveries --maintenance-database postgres` | 列出未完成的完整 recovery：phase、scratch 資料庫是否還在、該次已寫入的 storage 物件數 |
| `commerce restore --discard JOURNAL --maintenance-database postgres --yes` | 回收一個未完成的 recovery：刪掉它寫入的 storage 物件、drop 其 scratch 資料庫、移除 journal（cutover 已生效者拒絕） |
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

## 物件儲存

預設 `storage.driver: local` 會把不可公開的物件寫到 `<paths.dataDir>/storage`；Docker 的
`commerce-data` volume 與原生的 `/var/lib/commerce` 都必須保留，不能隨 release 一起刪除。
多主機部署請改用私有 S3 相容 bucket。bucket、prefix、endpoint 可寫在 `storage.s3`，但
`accessKeyIdRef`／`secretAccessKeyRef` 只填 secret 名稱，值仍由 secret provider 取得。

公開下載權限由 StoreWeave 管理，S3 bucket 不應設 public ACL。一般私有下載需要 `storage:read`；
短效連結需要 `storage:share` 及 `security.signingKeys`。簽章金鑰輪替時，保留舊金鑰直到最後一個
已發出的連結到期。把 local 與 S3 互換前，先以 object id、大小與 SHA-256 驗證完整複製，切勿直接
刪除原本的 metadata 或 bytes。

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

- **機器用 API token**。給 MCP 客戶端與 ERP 這類非瀏覽器呼叫端使用，不套用 CSRF 檢查。
  Token 存在資料庫，由 CLI 簽發，**秘密只在簽發的當下顯示一次**（ADR 0043）：

  ```bash
  sudo -u commerce commerce token:create --name mcp-client --role mcp --expires-in-days 90
  sudo -u commerce commerce token:list
  sudo -u commerce commerce token:revoke mcp-client
  ```

  撤銷是立即的：下一個請求就不通過，不必改設定也不必重啟。每一把都必須有到期日
  （預設 90 天），`token:list` 的 `last-used` 讓你看得出哪一把已經沒有人在用。

  **設定檔裡不再有 `auth.tokens`**。升級舊部署時，先用 `token:create` 換發一把新的、
  更新呼叫端，再把設定檔裡的 `auth.tokens` 區塊刪掉——留著會讓設定驗證失敗，
  這是刻意的，安靜忽略等於讓一批以為還有效的 token 在下次部署後突然失效。

密碼重設、信箱驗證與信箱變更都已實作，連結由平台簽發並寄出（見下一節與 ADR 0042）。

- **停用帳號**走 `platform.identity.setUserStatus`（權限 `users:write`），停用同時撤銷
  該帳號所有 session，不必再直接改資料庫。操作者不能停用自己——最後一個管理員把
  自己關在門外之後，復原需要的正是另一個管理員。
- **登入失敗鎖定**：同一個帳號連續失敗十次會被鎖十五分鐘，鎖定期間即使密碼正確也
  拒絕，而且訊息與密碼錯誤完全一樣。成功登入即歸零，時間到自動解鎖，不需要人介入。
  這一層擋的是「很多來源打同一個帳號」；「一個來源打很多次」由 HTTP 的 per-IP 限流擋。
- **二階段驗證**對 admin／staff／readonly 是必要的（ADR 0044）。還沒設定的帳號仍然
  登得進來，但登入回應會帶 `mfaEnrolmentRequired`——第一個管理員得先進得來才設定得了。

```bash
# 使用者自己在後台完成：POST /api/v1/auth/mfa/enroll → 掃 QR → mfa/confirm
# 復原碼只顯示一次，遺失只能用一組有效代碼重發（mfa/recovery-codes，舊的一批同時作廢）
```

後台的帳號管理與登入復原頁面由 B13 補上；在那之前這些流程走 HTTP 與 CLI。

尚未實作的部分：後台的帳號管理 UI。

## 簽章金鑰

密碼重設信、信箱驗證信與短效下載連結都是「離開行程之後還要驗得回來」的值，
一律簽發成 `sw1.<key id>.<到期>.<內容>.<簽章>`（ADR 0038）。**沒有金鑰的部署會啟動失敗**
（ADR 0042），這是刻意的：一個不能重設密碼的商店不是精簡設定。

```yaml
security:
  signingKeys:
    - id: k1
      secretRef: COMMERCE_SIGNING_KEY_K1
```

秘密至少 32 bytes，base64url 或 hex：`openssl rand -base64 32`。設定檔裡永遠只有名稱。

輪替不需要停機，順序是**加一把 → 改 `activeSigningKeyId` → 等舊連結到期 → 再移除舊的**：

```yaml
security:
  signingKeys:
    - { id: k1, secretRef: COMMERCE_SIGNING_KEY_K1 }
    - { id: k2, secretRef: COMMERCE_SIGNING_KEY_K2 }
  activeSigningKeyId: k2
```

兩把以上時 `activeSigningKeyId` 必填——輪替期間簽錯金鑰是無聲的錯誤。
**從設定移除一把金鑰，等同立即作廢它簽過而尚未到期的所有連結**；這是疑似外洩時
唯一夠快的手段，但不是清理設定的順手動作。key id 一旦發行也不能改指到另一個秘密。

## CORS

預設不啟用。要讓瀏覽器中的另一個網站讀取 API，明確列出它的 origin；空清單不註冊 CORS 或自動 `OPTIONS *` 路由：

```yaml
http:
  cors:
    allowedOrigins:
      - https://console.example
    credentials: false
```

只能填 `http`／`https` origin（可帶唯一的結尾 `/`）；不能有帳密、路徑、query、fragment、萬用字元或重複的正規化 origin。大小寫 host 與預設 port 會正規化。`credentials: true` 必須至少有一個 origin；它不會從 `http.publicUrl` 推導。

這只讓瀏覽器讀取 allowlist 的回應，不是登入或 CSRF 豁免：session cookie、same-origin／CSRF、Bearer token 與既有權限仍照常生效。預檢固定只公告 `GET, HEAD, POST, PUT, PATCH, DELETE` 及 `Authorization, Content-Type, Idempotency-Key, X-CSRF-Token, X-Correlation-Id`，並 expose `Retry-After`。

allowlist 的正常預檢回 `204` 與精確的 `Access-Control-Allow-Origin`；不在 allowlist 的正常預檢仍是 `204`，但沒有 ACAO。缺少 `Origin` 或 `Access-Control-Request-Method` 是 Fastify 的嚴格預檢，回 `400 text/plain` 與 `Invalid Preflight Request`。不支援的 method／header 或不存在的 path 也可能回 `204`，但只公告固定清單，瀏覽器會拒絕；不要把它當成授權成功。一般跨站請求仍會跑原 handler，只是不給 ACAO。

生成的 `base.schema.json`／`commerce.schema.json` 保留 `format: uri`，但 JSON Schema 無法完整表示上述 origin-only 限制；部署時以 runtime 設定驗證為準。

## 健康端點

| 端點 | 語意 | 狀態碼 |
| --- | --- | --- |
| `/health/live` | 行程還活著 | 恆 200 |
| `/health/ready` | 可以接流量：資料庫連得上且沒有待套用的 migration | 200 / 503 |
| `/health/dependencies` | 資料庫、Outbox、佇列、Worker 心跳、各 Provider、各 Extension | 200 / 503（需 bearer token） |
| `/health/metrics` | 穩定的 queue／scheduler／mail／storage 計數，不含 worker id 與診斷文字 | 恆 200（需 bearer token） |

`/health/live` 與 `/health/ready` 不需要 API token，可直接給負載平衡器使用。
`/health/dependencies` 是含有 provider 錯誤訊息、佇列深度與 worker id 的維運視圖，必須使用具權限的
bearer token；監控應以安全的憑證或內網呼叫它。`/health/metrics` 供監控器採集固定數值欄位：outbox、
job status、worker 心跳年齡、scheduler 的暫停／跳過計數、mail 狀態（含 partial）及 storage 可用性；不要解析
`dependencies` 的人類可讀 `detail` 字串。兩者都不該公開在 Internet。doctor 另有安裝、設定、目錄與 secret 檢查。

`/health/metrics` 一律回 200，即使某一項查詢失敗或 outbox 有 dead 訊息：Prometheus、Datadog、CloudWatch
agent 等採集器對非 2xx 一律視為 scrape 失敗並丟棄整份 payload，把告警狀態綁在狀態碼上會讓事故當下最需要
的計數反而採不到。告警邏輯一律讀 body 的 `status`（`ok` / `degraded` / `down`）與各項計數，不要看 HTTP
狀態碼。`/health/ready` 與 `/health/dependencies` 的 200 / 503 語意不受影響，兩者是給探針與維運視圖用的。

啟用 ECPay 時，`provider:payment:ecpay` 會標示離線設定已驗證、外部連通性與 callback delivery 仍需 UAT：
它只驗證離線設定與 extension health，不會探測 ECPay 或證明 callback 可達。正式切換與 callback 失敗處置見
[ECPay Checkout 上線 Runbook](runbooks/ecpay-release.md)。

## 監控建議

| 指標 | 來源 | 門檻建議 |
| --- | --- | --- |
| Outbox 積壓 | `/health/metrics` 的 `outbox` | pending > 500 轉 warn、dead > 0 直接 fail（門檻寫在 `health.ts`） |
| 工作佇列 dead | `/health/metrics` 的 `jobs.dead` | dead > 0 就告警 |
| Worker 心跳 | `/health/metrics` 的 `worker.lastSeenAgeSeconds` | 啟用 worker 時：沒有 heartbeat 或超過 300 秒為 fail；超過 60 秒為 warn。worker disabled 時不告警 |
| 排程遺漏／暫停 | `/health/metrics` 的 `scheduler` | `paused`、任一 `skipped*` 上升時確認是否屬預期維護 |
| Mail | `/health/metrics` 的 `mail` | enabled 時 `partial`、`unknown` 或 `rejected` > 0 告警；disabled 是正常狀態 |
| Storage | `/health/metrics` 的 `storage.available` | false 立即告警；不公開 bucket／key／錯誤原文 |
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
