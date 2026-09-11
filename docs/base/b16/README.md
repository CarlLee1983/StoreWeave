# B16 — 可照做的模組範例

- 狀態：done（驗證紀錄見下方）
- 日期：2026-09-11
- 分支：`feat/b16-module-example`，基準 `fb5989b`（main，B14 合併後）
- 範圍：[Base 計畫的 B16 派工卡](../../base-implementation-plan.md#b16--可照做的模組範例)、Spec 0009 F15 與 §8 第四、五項
- 決策：[ADR 0050](../../adr/0050-modules-declare-resources-and-upload-intakes.md)；步驟文件：[模組開發](../../module-development.md)

前置 B05、B07、B08、B10、B11、B12、B13 在 main 上皆已結案。

## 為什麼要動 base

派工卡的出口是「新接手者依文件只新增模組及站點組裝，不改 base」。照做時發現四個缺口，都是 base 缺公開入口，
因此由本包補上，之後的模組不必再改：

| 缺口 | 補上的入口 |
| --- | --- |
| `ReleaseDefinition` 傳不了 B09／B11 的 storage／cache binding，經 release 組裝的模組拿不到 scope | `PlatformModule.resources` ＋ `bindResources`；runtime 以模組名推導 namespace 綁定 |
| 前台頁面只收表單，全域 multipart 不收欄位、CSRF 只讀 body，模組收不了檔案 | `PlatformModule.uploads` ＋ 通用 `POST /api/v1/modules/:module/uploads/:upload`（`ModuleUploadsController`，以收件 Command 的權限把關、`upload` 節流桶，base 與 commerce adapter 都掛上） |
| Admin SPA 路由表編譯期固定、只有 commerce 打包後台 | 非商務模組的後台畫面用 `audience: 'operator'` 的模組頁面；base Theme 匯出 `renderBaseLayout` 讓模組 renderer 沿用外框 |
| 模組沒有對應 Extension Contract Test 的工具 | `@storeweave/bundle` 的 `runModuleContractChecks(release, module)`／`assertModuleContract` |

另外 `tests/architecture/session-start-single-entry.test.ts` 原本寫死「兩個 release」；改成逐一載入 `apps/api/src/releases/`
下的每個 adapter 做同樣的值比對。只換 release id、沒有自己的 controllers 也不碰 `startSession` 的 adapter
（`{ ...baseHttpAdapter, releaseId }`）視為沿用 base 的接線；其餘一律要自己接 `this.startSession`。
新增 release 不必再回來改這條守衛。為了讓 handler 判斷最後一次嘗試，`@storeweave/jobs` 匯出 `DEFAULT_JOB_MAX_ATTEMPTS`；
為了讓 handler 依權限限縮範圍時與授權同一套比對（含 `scope:*`），`@storeweave/authorization` 匯出 `actorHolds`。

## 交付

**範例模組** `packages/examples/file-requests`（模組名 `file-requests`，公開名稱 context `filerequests`）：

- 資料：`file_requests_records` 一張表，`0001_init` migration，狀態以帶條件的 UPDATE 轉換。
- 權限：`file-requests:submit`（會員、staff）、`file-requests:review`、`file-requests:process`（staff），由 release 授予。
- 前台授權上傳：intake `request-file`（`text/plain`、`text/csv`）→ `filerequests.request.submit`，核對物件擁有者；
  每人未結案的申請上限 10 筆，標題拒絕控制字元。
- Job：`filerequests.process`（計算 SHA-256 與行數；暫時性故障重試，空檔、非純文字或用完嘗試次數記為失敗）；
  `filerequests.cleanup`（cron `30 3 * * *` Asia/Taipei，先把超過保留期的已結束申請標成 `purging`，再刪物件與列）。
- 通知：處理完成／失敗／審核結果發站內通知給申請人；待審核信寄給 release 設定的 `store.supportEmail`。
- Cache：審核計數快取 30 秒，寫入時失效，故障時回資料庫。
- 頁面：`/file-requests`（我的申請與上傳表單）、`/file-requests/:id`、`/file-requests/review`（待審核與處理失敗分開查）、審核與重新處理的表單 POST。
- 事件：`filerequests.request.submitted.v1`、`filerequests.request.decided.v1`。

**站點組裝** `file-requests` release：`packages/platform/bundle/src/releases/file-requests.ts`、
`apps/api/src/releases/file-requests.ts`、`scripts/releases.mjs`、`scripts/build-release.sh`、`scripts/seeds/file-requests.ts`。

## 驗收對照

| 派工卡／Spec 要求 | 證據 |
| --- | --- |
| 自己擁有資料表、透過正式公開入口接入 | `packages/examples/file-requests/src/module.ts`；`tests/architecture/module-example-boundaries.test.ts` 掃描 import |
| 前台授權上傳 → 排 job → 背景處理 → 狀態查詢 → 寄信／站內通知 | `tests/integration/file-requests-example.test.ts` 第一支（HTTP 全程） |
| 後台查詢／處理 | 同上：staff 審核頁 200（60 筆結案資料之後仍列出待審）、會員 403、審核 303、缺 `_csrf` 403、重複審核 400；失敗申請的重新處理在第四支 |
| Worker 重啟重試 | 第二支：第一個 runtime 的 worker 處理失敗後關閉，新 runtime 的 worker 重試成功，通知只有一筆；第三支：用完五次嘗試記為失敗 |
| 授權拒絕 | 未登入 401、缺 CSRF 403、無權限 token 403（且不寫入任何物件）、他人申請 404、會員審核 403、會員重新處理 403 |
| 上傳配額與輸入 | 第一支：標題含換行 400；第四支：同一人第 11 筆未結案申請 409 |
| 非法依賴／版本／權限、命名衝突 | `packages/platform/bundle/test/module-contract.test.ts`；`tests/architecture/module-graph.test.ts` |
| 清理有明確目標、不影響其他模組 | 第五支：只刪過期且已結束的申請與其物件，進行中的申請與 `platform-storage` 物件保留；標成 `purging` 的申請不能被重新處理 |
| 完整 migration／permission／routes／job／template 宣告與同一介面的測試 helper | 模組各檔；`runModuleContractChecks`；`packages/examples/file-requests/test/contract.test.ts` |
| runtime／browser 依賴未跨層 | `tests/architecture/module-example-boundaries.test.ts`：執行期檔不引用 Theme 層，Theme 檔只用 kernel 型別與 i18n |
| 上傳入口本身 | `tests/integration/module-uploads.test.ts`：以收件 Command 權限授權先於 body、input 預檢、content type、大小上限、Command 失敗刪物件 |
| 資源綁定 | `tests/integration/module-resources.test.ts`：只給宣告的 scope、namespace 由模組名推導、與既有 binding 重複時拒絕 |

## 限制與未涵蓋

- 瀏覽器上傳需要 JavaScript（`fetch` 帶 `X-CSRF-Token`）；沒有 JS 的表單上傳需要改全域 multipart 與 CSRF 規則，另案。
- `audience: 'operator'` 只涵蓋 `user` 型別；把同一組頁面放進 commerce release 時，顧客（`customer`）進不來。
- `scripts/build.mjs` 的「不得打包 commerce」檢查仍只針對 `base` release，沒有延伸到 `file-requests`；本包以實際建置的 metafile 人工確認 api／worker／cli／seed 四個 bundle 都沒有 commerce 或 extension 輸入。
- 真實 SMTP 投遞未驗證；測試環境 `mail.transport` 為 `disabled`，審核信記為 `skipped`（投遞紀錄存在）。
- 上傳入口的補償刪除失敗只寫 log，物件留在模組 namespace 裡成為孤兒；平台沒有依模組清掃孤兒物件的機制。
- `upload` 節流以 IP 為鍵，同一 NAT 後的使用者共用額度。
- 範例是驗證與教學用的 release，不是要上線的產品；B17 的「三種網站」驗收另行組裝。

## 驗證

2026-09-11，基準 `fb5989b` 上的未提交工作樹（隨本包的 commit 提交）。

- `make verify` 的五個目標：`typecheck`、`typecheck-admin` 通過；`test` 96 檔 1171 支、`test-admin` 32 檔 350 支通過；
  `test-integration` 103 檔中 102 檔通過，唯一失敗的 `tests/integration/http-and-mcp.test.ts` 是 commerce 路由與節流桶的釘選清單
  （新增上傳入口後 controller／route 各多一、多一個 `upload` 桶）。更新釘選後該檔 73 支通過，並重跑 typecheck。
  第一次完整執行因主機記憶體不足被系統中止（同時有其他 Testcontainers 在跑），改為依序跑剩下的目標；兩次之間沒有改動原始碼。
- `STOREWEAVE_RELEASE=file-requests node scripts/build.mjs --skip-admin` 建置成功：manifest 含 `file-requests` 模組，
  api／worker／cli／seed 四個 bundle 的 metafile 沒有 commerce 或 extension 輸入。`pnpm install --frozen-lockfile` 通過。
- 獨立審查（code-reviewer）：無 CRITICAL；2 個 HIGH（審核頁被結案資料擠滿、會員可無限上傳）與 5 個 MEDIUM
  （intake 權限與 Command 權限分岔、清理與重新處理的競態、死信讓申請卡在排隊、標題換行讓寄信失敗、上傳 controller 只接在範例 release）
  全部修正並補回歸測試；LOW 中的 wildcard 權限、串流未關閉、非純文字內容與 session 守衛放寬一併處理，
  補償刪除失敗留下孤兒物件列為限制。修正後未再做第二輪獨立審查。
- 未執行：Docker／native release smoke（`pnpm smoke:docker`、`pnpm smoke:native`）與真實 SMTP。
