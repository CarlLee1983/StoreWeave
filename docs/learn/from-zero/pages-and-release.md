---
description: 把自己的筆記模組接成可操作的網站，從頁面、Theme 到獨立 Notes Release。
pageClass: architecture-page
---

# 接上頁面，啟動自己的產品

上一課建立了資料與操作，但讀者還沒有入口。這課把它們接成網站：用表單建立草稿、從列表打開單篇，最後用自己的 Release 啟動。

你可以先跑本頁前半的完整範例，再依後半拆解它。完整實作位於 [`packages/examples/notes`](../../../packages/examples/notes/)，它是學習用的參考答案；你不需要先把所有片段抄完才能看見結果。

## 1. 先啟動完整範例

前置條件：已下載這份包含 Notes 範例的 repository，Docker 與 Compose 可用，本機 3001 port 未被使用。所有指令在 repository 根目錄執行。
此處會建立 **Notes 專用的新資料庫**。不要把之前 Base 或 Commerce 的資料 volume 接過來；它們是不同的 Release。

在同一個終端機執行：

```bash
docker info
docker compose version

export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export STOREWEAVE_SIGNING_KEY_K1=$(openssl rand -hex 32)
export STOREWEAVE_PORT=3001
export STOREWEAVE_CONFIG_PATH=./deployments/notes.example.yaml
export STOREWEAVE_IMAGE=storeweave/notes:learn

docker compose -p storeweave-notes-learn -f compose.notes.yaml up -d --build
docker compose -p storeweave-notes-learn -f compose.notes.yaml ps
```

第一次建置需要下載映像與依賴。`postgres`、`api` 應在啟動後呈現 healthy，`worker` 應持續執行。需要查看原因時：

```bash
docker compose -p storeweave-notes-learn -f compose.notes.yaml logs --tail=80 api worker
curl -i http://localhost:3001/health/ready
```

**檢查點：** 健康端點回 HTTP 200，在瀏覽器開啟 <http://localhost:3001/notes>，看到「目前沒有筆記」。這是有效的空列表，不是錯誤。

保留這個終端機及原本的密碼、金鑰。若要跨工作階段繼續使用資料，將同一組值保存至自己的受保護機密管理位置；不要對已有資料 volume 重新產生密碼。
本課明確設定 config、image 與 port，避免沿用上一條 Base 教學在 shell 裡留下的選擇。

依據：[Compose](../../../compose.notes.yaml)、[Notes Dockerfile](../../../docker/notes.Dockerfile)、[啟動流程](../../../docker/notes-entrypoint.sh)、[設定範本](../../../deployments/notes.example.yaml)。

## 2. 從註冊走到第一篇筆記

1. 開啟 `/register`，使用練習用 Email 與至少 8 個字元的密碼註冊。這裡建立的是 Base 身分系統的會員，沒有購物顧客資料。
2. 開啟 `/my-notes`，按「新增筆記」。
3. 輸入標題與本文，按「建立草稿」。成功後回到「我的筆記」，應有一筆草稿。
4. 點開筆記，修改本文，再按「儲存草稿」。回到列表後再打開，應看見保存的內容。
5. 在編輯頁按「發布」，再開啟 `/notes`。從公開列表點入文章，應看見剛才儲存的本文。
6. 用未登入的另一個瀏覽器視窗開啟該公開網址，仍應可讀。回到作者視窗「收回草稿」後，匿名視窗重新整理應回 404。

發布按鈕發布的是**已儲存**的內容，不會順便儲存尚未送出的編輯。這個小範例沒有自動儲存或富文字編輯器。
範本停用寄信，所以本機練習不包含信箱驗證與忘記密碼郵件；此範例也沒有額外要求作者必須完成信箱驗證才能發文。

**檢查點：** 你能實際證明草稿只有作者可看，公開文章不用登入也可看。下一課會進一步以第二位作者驗證資料隔離。

## 3. 畫面是怎麼接到 Command 的？

對照 [pages.ts](../../../packages/examples/notes/src/pages.ts) 的 `create`：

```text
GET /my-notes/new
  → Page 建立 operationId
  → Theme 顯示表單與 CSRF 欄位

POST /my-notes
  → 共用路由驗證 Session 與 CSRF
  → Page 解析 title、body、operationId
  → notes.entry.create（帶目前 Actor 與冪等鍵）
  → handler 在 ctx.tx 寫入 notes_entries
  → 回應 303，瀏覽器前往 /my-notes
```

Page 透過 `ctx.commands.execute` 使用既有 Command；它不直接操作資料表。`operationId` 放在執行選項的 `idempotencyKey`，不是留言或文章資料欄位。

同樣地，公開單篇 Page 只呼叫 `notes.entry.getPublished`，作者編輯頁只呼叫 `notes.entry.getMine`。兩個入口選擇不同查詢，是為了讓公開頁面根本拿不到草稿。

| 你要接的入口 | Page 做的事 |
| --- | --- |
| `GET /notes` | 查詢已發布列表，帶 `offset` 分頁 |
| `GET /notes/:id` | 查詢一篇已發布筆記；不存在或草稿回 404 |
| `GET /my-notes` | 查詢目前作者的筆記 |
| `GET /my-notes/new` | 準備建立表單 |
| `GET /my-notes/:id` | 查詢作者自己的筆記，準備編輯或收回表單 |
| `POST /my-notes` | 建立草稿 |
| `POST /my-notes/:id` | 儲存草稿 |
| `POST /my-notes/:id/publish`、`/unpublish` | 發布或收回 |

這個範例使用 HTML 表單入口，沒有額外建立 Notes REST controller。內部 Command 名稱不會自動變成 HTTP URL；如果你要提供 JSON API，必須另外設計與接上自己的 HTTP adapter/controller。

## 4. 頁面宣告與 Theme 分開寫

在 `pages.ts`，每個 Page 宣告網址、方法、audience、輸入與回應契約。`operator` 在這個 Release 指已登入的 `user`，不等同「必須是管理員」。真正的權限與資料範圍仍由 Command／Query 檢查。

只寫入與轉址的 Page 設為 `required: false`，因為它沒有自己的畫面；顯示頁必須有 renderer。

接著看 [theme.ts](../../../packages/examples/notes/src/theme.ts)：

```ts
export const notesTheme: StorefrontTheme = {
  ...baseTheme,
  renderers: {
    ...baseTheme.renderers,
    'notes.entry.index': list,
    'notes.entry.mine': list,
    'notes.entry.new': editor,
    'notes.entry.edit': editor,
    'notes.entry.view': detail,
  },
};
```

`list`、`editor` 與 `detail` 都在同一份完整來源中。它們取得整理好的 view，用 `renderBaseLayout` 保留網站外框，再以 `escapeHtml` 輸出使用者文字。
本文用純文字呈現，不把 `<script>` 或 HTML 標籤當成指令執行。Theme 沒有資料庫連線，也不決定誰有資格發布。

**練習：** 在自己的 Notes `theme.ts` 為公開文章加一行閱讀提示，重新建置後確認提示出現，但草稿仍不公開。不要修改共用 `packages/themes/base`；差異留在自己的 Theme。

## 5. 用 Release 把自己的程式接起來

看 [runtime.ts](../../../packages/examples/notes/src/runtime.ts)，Notes 選擇的產品能力只有：

```text
platform-site  → 網站設定與首頁
platform-auth  → 登入、註冊等認證頁面
notes          → 你自己寫的筆記資料與規則
```

平台的資料庫、授權、身分、工作等基礎模組由共用 runtime 組裝。這三項是 Notes 明確選擇的應用模組，並不代表啟動後資料庫只會有三張表。

不要只把 `createNotesModule()` 加到某處，就期待所有執行目標自動認識產品。依序對照：

1. [definition.ts](../../../packages/examples/notes/src/definition.ts)：宣告 `notes` Release 身分、選取的模組／Theme 與六個 target keys。
2. [runtime.ts](../../../packages/examples/notes/src/runtime.ts)：建立模組、角色與導覽。
3. [storefront.ts](../../../packages/examples/notes/src/storefront.ts)：把 Notes Theme 提供給網站。
4. [server.ts](../../../packages/examples/notes/src/server.ts) 與 [HTTP adapter](../../../apps/api/src/releases/notes.ts)：接上共用認證及網站路由，沒有 Content 或購物 controller。
5. [worker.ts](../../../packages/examples/notes/src/worker.ts)、[cli.ts](../../../packages/examples/notes/src/cli.ts)、[config.ts](../../../packages/examples/notes/src/config.ts)、[admin.ts](../../../packages/examples/notes/src/admin.ts)：分別宣告背景執行、維運工具、設定與停用的 Admin 目標。
6. [scripts/releases.mjs](../../../scripts/releases.mjs)：登記各建置入口。建置工具從這裡找到 `notes`。

Notes 沒有 `/admin`；作者工作介面就是 `/my-notes`。你仍可以使用平台認證與權限，不需要先開發 React 後台。

## 6. 完成後如何停止？

```bash
docker compose -p storeweave-notes-learn -f compose.notes.yaml down
```

這會停止容器並保留資料 volume。下次啟動沿用同一組環境變數與原密碼；不要加 `-v`，除非你已確定要刪掉整個練習資料庫與儲存資料。

下一課：[權限、發布與重複操作](permissions-and-publishing.md)。需要建置、測試、排錯與交付說明時，接著讀[測試與交付](test-and-ship.md)。
