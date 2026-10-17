---
description: 驗證 Notes 模組的成功、拒絕與重複操作，再建置自己的 Release 並理解部署限制。
pageClass: architecture-page
---

# 驗證功能，再交付自己的 Release

你已經有自己的資料、規則與畫面。最後要回答的是：「它只在我的成功操作裡能用，還是也能正確拒絕錯誤操作、重啟後保留資料？」

本課使用隨範例提供的真實測試。請在 repository 根目錄執行；主機需有 Node.js 22 以上、專案釘選的 pnpm，以及已安裝的依賴。整合測試需要 Docker。

## 1. 先檢查宣告是否接齊

```bash
pnpm exec vitest run --project unit packages/examples/notes/test/contract.test.ts
```

預期三個測試通過。它們檢查：模組與 Release 契約有效、Notes 未組入 Content／Order、不同的 selection 被拒絕，以及輸入不接受空標題、指定他人 owner 或缺少 revision 的更新。

這是快速回饋，還沒有啟動資料庫。對照 [contract.test.ts](../../../packages/examples/notes/test/contract.test.ts)，理解「宣告正確」與「操作真的成功」是不同證據。

## 2. 再走一次真實 HTTP 與資料庫流程

```bash
pnpm exec vitest run --project integration tests/integration/notes-example.test.ts
```

測試會使用 testcontainers 的 PostgreSQL，在獨立測試資料庫建立 Notes Release，不會使用 Compose 裡的練習資料庫。
它透過實際的 `/register` 與表單入口執行流程，覆蓋以下情境：

- 新作者可建立草稿、編輯、發布與收回。
- 缺少 CSRF 的寫入被拒絕；沒有寫入權限的 Actor 不能執行 Command。
- 另一位作者不能看見或發布別人的草稿，即使擁有萬用權限也不繞過資料擁有者限制。
- 匿名讀者看不到草稿，只能讀取已發布文章；收回後重新讀取為 404。
- 同一個操作重送只建立一次；不同作者使用相同操作鍵仍各自獨立。
- 過時 revision 被拒絕；兩次競爭同一 revision 的更新只有一次成功。
- 使用者輸入作為文字呈現；重啟後仍能讀到已保存資料。
- 資料庫沒有 Content、商品或訂單資料表。

**檢查點：** 一個整合情境通過。失敗時先讀第一個 assertion 的 expected／received 與對應步驟，不要先放寬斷言。

完整來源：[notes-example.test.ts](../../../tests/integration/notes-example.test.ts)。它也示範如何建自己的測試環境與回收資源。

## 3. 用一次刻意失敗，確認你理解規則

在瀏覽器開啟同一篇草稿的兩個編輯分頁。先在第一頁修改並儲存，再在第二頁儲存不同內容。

**預期：** 第二頁得到衝突回應，不能默默蓋掉第一頁的內容。重新打開筆記，應看見第一頁保存的版本。
若要套用第二頁內容，先保留自己的文字，再讀取最新版本、確認差異後重新編輯。範例沒有自動合併或版本歷史。

接著用匿名視窗查看該草稿網址。即使你知道 UUID，也應回 404。這兩個小實驗分別驗證 revision 與公開查詢的責任，不能互相取代。

## 4. 建置你的 Notes Release

```bash
STOREWEAVE_RELEASE=notes pnpm build
```

建置輸出在 `dist/`。Notes 沒有 Admin browser app，但會產生 API、Worker、CLI 與 Release metadata。
選擇是建置時決定；只在已建好的 Commerce 程式前加上 `STOREWEAVE_RELEASE=notes`，不會把它轉成 Notes。

建置過程使用 [registry](../../../scripts/releases.mjs) 的輸入限制，檢查 Notes 產物不混入未選用的產品實作。
資料庫的表清單由整合測試驗證，建置依賴則由 artifact metadata 檢查，兩者都要看。

程式變更完成前，執行 repository 的完整門檻：

```bash
make verify
```

它依序跑後端與後台型別檢查、unit、admin、integration。完整檢查可能需要數十分鐘；看到一部分測試通過不代表整體完成。
文件有變更時另跑 `pnpm docs:build`。這些指令的依據是 [Makefile](../../../Makefile) 與 [package.json](../../../package.json)。

## 5. 從本機範例到部署，要補哪些事？

上一課提供的 [Notes Compose](../../../compose.notes.yaml) 與[專用 Dockerfile](../../../docker/notes.Dockerfile) 是本機學習的可執行交付方式。服務綁定 `127.0.0.1`，不會直接開放到其他主機。

交付到正式環境時，仍需依自己的場域完成：

| 要處理的項目 | 為什麼需要 |
| --- | --- |
| 正式網域、TLS 與 `http.publicUrl` | 登入與通知使用的網址必須符合實際入口 |
| 密碼與簽章金鑰的保存 | 重啟不能靠重新產生一組秘密來替代輪替 |
| 資料庫與檔案備份、還原演練 | 程式可以重建，資料不能假設重建得到 |
| migration 時機與 writer 停止程序 | 本機自動 migration 不能直接當作多節點升級流程 |
| 郵件與帳號政策 | 範本停用寄信，沒有完成正式的信箱驗證與重設密碼交付 |
| 監控、容量與濫用處理 | 此教材未驗證壓力承載、內容審核或公開服務營運 |

Notes 的 registry 沒有提供 `native` 打包資料，因此這個範例**沒有原生安裝媒體**。不要直接套用其他 Release 的 tarball 當成自己的成品。
一般部署概念可參照 [Docker 部署](../../deployment-docker.md)，產品名稱、路徑與設定則以 Notes 檔案為準。

## 6. 升級與回復時保護資料

`0001_init` 是建立資料表的 additive migration。發布過後不要修改它的內容；下一次資料結構變更寫成新的 migration。

回退程式版本不代表資料庫也自動回退。Notes 沒有自動 DROP 或 down migration；停止應用時保留資料，必要時從事先驗證的備份還原。
不要把 Notes 資料庫直接換成 Base 或 Commerce 啟動來「回復」：Release history 與模組所有權也在檢查範圍內。

## 常見卡點

| 現象 | 先看哪裡 |
| --- | --- |
| 啟動時說缺少 renderer | `pages.ts` 的必需頁面 ID 是否在 `theme.ts` 註冊 |
| Command 或 Query 找不到 | `module.ts` 是否註冊，`runtime.ts` 是否組入自己的模組 |
| 已登入卻不能操作 | Release 角色是否授權；目前 Actor 是否真的是筆記作者 |
| 儲存回 409 | revision 已過時或筆記仍為 published；重新開啟後確認狀態 |
| 送出回 403 | Session／CSRF 或權限檢查失敗，不能只移除表單欄位來繞過 |
| 公開文章回 404 | 是否已發布、是否使用 `/notes/:id`，而非作者自己的網址 |
| 重啟後連不到 PostgreSQL | 是否誤換了原來的密碼；不要對既有 volume 重新產生密碼 |
| 日誌提到缺少 Content discovery query | 共用網站 context 會嘗試查詢內容種類；Notes 沒有 Content，既有 fallback 使用空清單。這不代表需要把購物或 Content 加回去 |

## 下一個功能由你決定

先選一個小需求，例如「草稿搜尋」或「文章摘要」。寫清楚使用者動作與成功／拒絕條件，再按第一課的檔案順序完成一次變更。

需要上傳、通知與背景工作時，對照[完整 file-requests 模組](../../module-development.md)；需要外部服務整合時，再看 [Extension 教學](../extension-lab.md)。那個練習訂閱的是 Content 的發布事件，**Notes 目前沒有宣告發布事件**，不能直接接上。若 Notes 需要事件，先在自己的模組定義事件契約，並在發布 Command 的同一交易呼叫 `ctx.publish`，再補上測試。

如果你的真正需求只是一般文章網站，也可以比較[沿用 Content 的 Blog 路線](../build-a-blog.md)。自己實作一次是為了理解基底；產品開發時，仍應優先使用符合需求的既有能力。
