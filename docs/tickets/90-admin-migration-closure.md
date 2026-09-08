# 90 — 完成後台遷移清理、文件與整體驗收

**GitHub:** [#27](https://github.com/CarlLee1983/StoreWeave/issues/27)

**What to build:** 驗證 16 routes 的完整遷移，移除最後無引用的舊互動／CSS，更新實際架構文件並留下可審查的交付與 rollback 證據。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 Acceptance Criteria、Verification and Rollback

**Blocked by:** [Ticket 81 / #18](https://github.com/CarlLee1983/StoreWeave/issues/18), [Ticket 84 / #21](https://github.com/CarlLee1983/StoreWeave/issues/21), [Ticket 85 / #22](https://github.com/CarlLee1983/StoreWeave/issues/22), [Ticket 86 / #23](https://github.com/CarlLee1983/StoreWeave/issues/23), [Ticket 88 / #25](https://github.com/CarlLee1983/StoreWeave/issues/25), [Ticket 89 / #26](https://github.com/CarlLee1983/StoreWeave/issues/26)

**Status:** done（2026-09-07；本機完整驗收，Sol/high Standards／Spec PASS，未提交或遠端寫入）

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-sol / high`

## Ownership

apps/admin 下已被前票取代的無引用樣式／helpers、DESIGN.md、docs/architecture.md、README.md 的受影響內容、Spec 0008 與本批 tickets 狀態／驗證紀錄。僅修復本批遷移造成的缺陷。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `docs/specs/0008-admin-foundations-and-contracts.md`
- `apps/admin/src/routes.tsx`
- `apps/admin/src/styles.css`
- `apps/admin/src/enhancements.css`
- `apps/admin/src/hooks/useEscapeKey.ts`
- `apps/admin/DESIGN.md`
- `docs/architecture.md`
- `.github/workflows/ci.yml`

## Acceptance Criteria

- [x] 逐項驗收 Spec 0008；記錄 16 routes＋Login 的測試結果，三語／雙主題／360px／1280px、keyboard／focus 由真實瀏覽器驗證。
- [x] 搜尋並移除確定無使用者的 overlay／menu／palette listeners、CSS selector、helper；仍有用途者具名說明，不靠 CSS 行數或 snapshot 數量結案。
- [x] 沒有新套件只為預留 Table／Form／router／ForgeFlow；Query keys、HTTP transport 與 routes 各有單一來源，完整 build 沒有 backend runtime 洩入 Admin。
- [x] 商品 CRUD、券／品牌編輯、會員調帳、退款／RMA、出貨、發票／ERP／DLQ 重試維持 payload、guard 與一次操作語意；所有必要 regression 存在。
- [x] 更新 DESIGN.md 與 architecture.md 為最終實作，標出已實作工具與仍延後的 RHF／TanStack Table；不修改無關歷史 ADR。
- [x] 記錄各票可回復單位和逆相依 rollback 順序；現有 CI 全綠才標記本輪完成，未跑的 integration／smoke 明列 blocker，不宣稱完成。

## Verification

pnpm typecheck；pnpm typecheck:admin；pnpm test；pnpm test:admin；pnpm build:admin；依 .github/workflows/ci.yml 的 PostgreSQL integration、Docker／native smoke 全部通過並記錄結果。Sol/high 最終獨立審查。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Out of Scope

為清理而全面重構、效能重寫、新業務能力、實際部署、ForgeFlowv2 實作。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。


## Execution plan（2026-09-07）

- [x] Sol/high 唯讀分析已完成並由主代理接受；`/tmp/storeweave-ticket90-sol-analysis.txt`，清理／文件／CI修復與隔離驗證邊界已確定。
- [x] **已完成：** Terra/high 清理已證實無使用者路徑、更新實際架構文件；處理既有測試基準失敗。主代理另擁有 rollback／驗收紀錄。
- [x] 主代理完整 CI／瀏覽器驗收，Sol/high 獨立最終複核；通過才標 done 並接 Base B00–B17。

前置89 Sol Standards／Spec PASS；Admin307、root561、typechecks／build、8read／13command／84layout已通過。authenticated gh issue27 與本地規格一致，未遠端寫入。
修改前715檔快照 `/var/folders/mp/2hbmdcp15qjfn3fhgctttgl40000gn/T/storeweave-ticket90-baseline-rnueccc1`（pointer `/tmp/storeweave-ticket90-baseline-path`）；不在此安裝或共享可變node_modules。
預備紀錄 `/tmp/storeweave-ticket90-preflight.md`：preserve既有release及無關dbcli容器；smoke必須隔離。既有promotion integration隔離缺陷與smoke事件數斷言需核對契約後最小修復，不修改production促銷數學。

Sol分析pane已關閉；`closure90`／`wA:p1A` Terra/high YOLO no-alt-screen唯一writer七檔，任務 `/tmp/storeweave-ticket90-implementation-assignment.md`。Primary擁有完整CI／browser／隔離smoke／本票與Spec驗收文件。

## Rollback units and dependency order

本輪尚未建立 commit；下表描述可審查的回復單位，不提供不存在的 commit SHA，也不宣稱已執行 rollback。操作前保存當前工作樹並辨識後續 Base 依賴；以各票的已驗證來源／修改前快照重建該語意切片的反向差異，檢查共用檔案中的後續修改，逐步驗證。不得 reset／clean 整個 dirty tree。

一個有效的逆拓樸順序為 **90 → 89 → 88 → 87 → 86 → 85 → 84 → 83 → 82 → 81**；這是可採用的線性順序，並非宣稱相邻每票都互相依賴。若後續 Base 工作已依賴本輪，先回復那些相依切片，再開始以下順序。

| Ticket | 可回復的語意單位 | 回復後最低驗證 |
| --- | --- | --- |
| 90 | 確定無引用的 CSS 清理、架構文件及兩項測試基準修正 | Admin build／視覺、文件引用；被回復的測試缺陷須明列，不宣稱 CI 綠 |
| 89 | 七營運頁 Query、五命令與 DLQ badge；shared keys/API 接線及 analytics invalidation | 七頁 reads／retry/key／badge／identity regression、Admin 全套 |
| 88 | 八商務頁 Query 與具體 operation helpers、共用恢復生命週期擴充 | 商品 foundation 加商務 payload／key／失效／身分切換 regression |
| 87 | 商品 Query 試點、QueryClient／key registry／operation foundation 與實際依賴 | 商品 CRUD／庫存／身分切換、typechecks／root與Admin tests；確認已無88/89 consumer |
| 86 | 外殼、登入與七營運頁 primitives／版型／鍵盤 | 16-route shell／Login、三語雙主題、palette／token／ERP回焦 |
| 85 | 訂單／會員／RMA／配送 UI 與操作呈現 | 金額／原因／payload／guard／冪等與回焦 regression |
| 84 | 促銷／券／loyalty／品牌 UI、DateField Popover 接合 | 四頁 sparse PATCH／日期／menu→dialog回焦與版型 |
| 83 | 商品頁 Dialog、庫存／編輯／列選單 UI | 商品 CRUD／庫存 guard、鍵盤與局部表格捲動 |
| 82 | Dialog／DropdownMenu primitives、RowMenu／ReasonDialog 接合及使用中的依賴 | 全部呼叫端已退回相容版本後，Admin tests／build與共用元件焦點驗證 |
| 81 | Order HTTP 的 browser-safe 型別投影與 awaiting_payment／reward UI 接合 | Order JSON／日期／狀態與 adjustment 契約，root＋Admin tests／build |

本輪無 DB migration，因此沒有資料 down migration。不要保留雙套 runtime 作為回復機制；回復後的單一來源仍須通過相應驗證。依賴 lockfile 只在消費者已依逆序移除後更新，不回復其他工作新增的套件。

### Additional visual closure findings

Primary Chromium expandedProducts3locale matrix發現360px四欄摘要溢出與pagination擠壓，已由同CSSwriter修成可讀窄版。目視JA版另發現原有Products硬編碼中文與本頁狀態筆數標示不清；此為本票三語／資訊範圍驗收缺口，ownership明確擴至ProductsPage.tsx、其test與i18n.tsx，只修呈現與標籤、不改query/API/operation邏輯。已完成修正並通過最終Sol複核。

## Verification record（候選5；最終通過）

| Gate | Current evidence |
| --- | --- |
| Root／Admin typecheck | PASS；最後 Product 三語追加亦 Admin typecheck PASS |
| Root unit | 48 files／561 tests PASS；後續只改 Admin 呈現文字 |
| Admin unit | 26 files／314 tests PASS；Products scoped-count／stock-forecast／phase／preview regression 全通過 |
| PostgreSQL integration | 58 files／505 tests PASS，`/tmp/storeweave90-integration.log` |
| Admin build／bundle | PASS；實際輸出323 modules 無 backend／Node runtime，module evidence `/tmp/storeweave90-admin-bundle-modules.json`；之後 Product copy build亦PASS |
| Docker smoke | 62 passed／0 failed，`/tmp/storeweave90-smoke-docker-round2.log`；之後只追加 Product copy，backend／smoke 契約未變 |
| Native smoke | 61 passed／0 failed，`/tmp/storeweave90-smoke-native-round2.log`；Bash5、隔離來源與 fresh release |
| Browser | 16 routes＋Login 共204 layout組合PASS；12 shell鍵盤、36 Product對話框（含非零forecast與價格preview）、3語operation phases PASS |
| Independent Sol/high | 原七檔 Standards／Spec PASS；三檔後續 findings 已修正；candidate5整票 Standards／Spec PASS，零剩餘發現 |

Candidate5 `/tmp/storeweave90-source-candidate5.json`715filehash。Native來源副本 `/tmp/storeweave90-native-path`，只調整執行用容器／network名稱、hostport及smoke暫存檔路徑；不修改repository build／native scripts。Docker用了temporarycomposeoverride與唯一project/image/port。Docker後已核對原release2461filehash與6無關容器不變；native後已核對全部相同；`/tmp/storeweave90-preservation-result.json`。現有Vitechunksizewarning、此macOS缺dpkg-deb因此僅產tarball是既有工具流程；本票要求native tarball smoke。


Native初次使用macOS Bash3.2，商品建立步驟出現JSON解析錯誤；同一最小repro僅切換到專案Bash5即PASS，直接HTTP請求也PASS。這是隔離執行環境差異，沒有修改API。最終native以明確HomebrewBash5與child PATH、fresh build、原cleanup語意執行。診斷與可重跑repro見 `/tmp/storeweave90-native-diagnosis.md`。Native61與Docker62之差為host `DEMO_ERP_API_KEY` 條件式檢查：Docker已執行payload不含key的檢查；native原始流程未向host匯出此值。

## Final acceptance（2026-09-07）

主代理逐項確認本票與 Spec0008 AC；Sol/high 最終 Standards／Spec **PASS，零發現**，完整 `/tmp/storeweave90-final-review.txt`。所有必要 repository CI 命令已在本機通過；未觸發或宣稱遠端GitHub CI run。

最終範圍：兩份CSS、ProductsPage及test、i18n、DESIGN、architecture、README、promotion-crud integration與smoke事件斷言，以及本票／Spec／索引／交接紀錄。沒有新增套件、DB migration、公開API、授權或command/query邏輯變更。原始stock理由／reference payload不因語言切換改變。

最終source/test/config76hash `/tmp/storeweave90-reviewed-source-final.json`；全部本機檔案快照hash `/tmp/storeweave90-complete-worktree-hashes.json`。Browser證據 `/tmp/storeweave90-primary-browser`：layout108-final.log、layout84-final.log、shell-login-final2.log、product-dialogs-final.log、product-phases.log；含source-grounded fixture／JSON／screenshots，無merchant/provider寫入。最後copy-only增量已由Admin314/build、三語phase與36dialog驗證，沒有為文字變動重跑未受影響的backend gates。

已完成81–90；下一階段依既定Base DAG從B00開始，B00–B17仍是完整後續目標，不以本票完成代替Base完成。現有Vitechunk-sizewarning保留；64／70商家UAT與91ForgeFlow來源仍是分開記錄的外部事項。未commit／push／merge／部署／GitHub寫入。
