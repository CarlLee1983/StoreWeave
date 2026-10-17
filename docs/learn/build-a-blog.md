---
title: 用現有模組做一個 Blog
description: 從第一篇草稿到公開文章，實際操作 Base 的內容 API，再辨認 Theme 與新功能的擴充邊界。
pageClass: architecture-page
---

# 用現有模組做一個 Blog

<div class="arch-lead">

第一個 Blog 可以先不寫新的模組。StoreWeave 的 content 已經有文章、草稿、發布、收回與公開頁面。本篇用一篇「週末手沖筆記」，走完從寫入資料到訪客閱讀的完整路徑。

</div>

完成後，你會得到 `/journal/weekend-coffee` 這篇公開文章，也會知道要改版面時動 Theme、要加留言等新規則時在哪裡開始。

本篇主線使用 **Base Release、HTTP API 與既有 Base Theme**。先完成[把網站跑起來](./getting-started.md)，讓 `http://localhost:3000/health/ready` 回應 `200`。沿用同一個終端機、`storeweave-learn` Compose project 與 `BLOG_TOKEN`。後面的命令在倉庫根目錄執行，需要 Docker Compose、`curl`，以及 **Node.js 22 以上版本**來執行 JSON 解析與 UUID 範例。若入門篇改過連接埠，請同步修改下面的 `BLOG_URL`。

::: info Base 沒有瀏覽器後台
Base 的 Admin projection 明確是 `enabled: false`，因此 `/admin` 回 `404` 是預期行為。本篇用 API 編輯文章；已經在使用 Commerce 的讀者可改走後面的[後台操作](#已經有-commerce-後台的話)。不要為了管理文章而把現有 Base 資料庫直接切成另一個 Release。
:::

來源：[Base 組入 content](../../packages/releases/base/src/runtime.ts#L15)、[Base Admin](../../packages/releases/base/src/admin.ts#L4)、[Base smoke 的預期路由](../../scripts/smoke-base.sh#L44)。

## 1. 先決定哪些東西直接沿用

這個 Blog 把文章放進既有的 `journal` 種類；畫面名稱是「生活誌」。`journal` 是 content 的四種文章種類之一，不是本篇新增的模組。

| 需要的行為 | 已有入口 | 這次要做的事 |
| --- | --- | --- |
| 建立、編輯草稿 | `createArticle`、`updateArticle` | 呼叫既有 HTTP API |
| 發布、收回 | `publishArticle`、`unpublishArticle` | 觀察狀態與公開頁面的變化 |
| 訪客看文章列表 | `/journal` | 沿用 `listPublishedArticles` |
| 訪客看單篇文章 | `/journal/:slug` | 沿用 `getPublishedArticle` |
| 標題、段落與列表外觀 | Theme renderer | 基本流程完成後再改 |
| 標籤篩選、留言、全文搜尋 | 本篇沒有提供這些行為 | 另行設計與實作 |

command 與 query 的完整名稱仍是 `commerce.content.*`，即使目前跑的是 Base。這是現有契約名稱，不代表需要啟用 Commerce。HTTP 的管理入口是 `/api/v1/content/articles`；公開閱讀則走 Theme 頁面，沒有在這裡另造一組 `/api/v1/blog`。

來源：[內容模組註冊](../../packages/platform/content/src/module.ts#L16)、[種類與輸入契約](../../packages/platform/content/src/dto.ts#L2)、[HTTP 對應](../../apps/api/src/controllers/content.controller.ts#L11)、[公開頁面](../../packages/platform/content/src/pages.ts#L178)。

## 2. 用 CLI 取得寫入憑證

文章管理需要 `content:read` 與 `content:write`。入門篇已簽發一天有效的 `blog-local` admin API token，並放進 `BLOG_TOKEN`。若你剛完成入門篇，直接執行本節最後的列表請求即可，**不必再簽發**。

如果你略過入門篇的 token 步驟，但網站已經在相同的練習環境啟動，才執行以下命令。它會在本機資料庫簽發憑證；秘密只顯示一次，請不要貼進文件或提交到 Git。

```bash
docker compose -p storeweave-learn -f compose.base.yaml exec api storeweave token:create \
  --name blog-local --role admin --expires-in-days 1
```

將輸出中的秘密輸入下面的提示；輸入時不會顯示在終端機上。這個寫法適用於 Bash 與 Zsh。

```bash
printf '貼上 blog-local 的 token：'
read -r -s BLOG_TOKEN
printf '\n'
```

接著確認管理 API 可讀：

```bash
BLOG_URL='http://localhost:3000'
curl -sS -H "Authorization: Bearer $BLOG_TOKEN" \
  "$BLOG_URL/api/v1/content/articles?kind=journal&limit=12&offset=0"
```

**檢查點：** 回應的 `success` 是 `true`，`data` 裡有 `items` 與 `total`。乾淨資料庫可能是空陣列，已有文章則會列出既有內容。若回 `401`，先確認 token 沒有複製到前後空白且尚未過期；若回 `403`，確認 token 的角色有需要的權限。

這裡以 Bearer 驗證，無須 CSRF token。使用瀏覽器 session cookie 的寫入則需要 `x-csrf-token`；Admin 的 API client 會處理它。每個內容 command 還必須帶 `Idempotency-Key`，下一步會實際用到。

CLI 在這條流程負責簽發 token；文章使用下面的 HTTP API。不要把內部 command 名稱當成現成的 `storeweave blog:create` 命令。

來源：[token CLI](../../tools/cli/src/main.ts#L532)、[權限與必要的冪等鍵](../../packages/platform/content/src/commands.ts#L14)、[Bearer 與 session 的驗證分支](../../apps/api/src/http/auth.ts#L95)、[管理列表 query](../../packages/platform/content/src/queries.ts#L7)。

## 3. 建立第一篇草稿

先在終端機準備這篇文章的 JSON。`body` 是段落陣列，每段可有標題；它不是 HTML，也不是完整的 Markdown 文件。

```bash
BLOG_ARTICLE='{
  "kind": "journal",
  "slug": "weekend-coffee",
  "title": "週末手沖筆記",
  "summary": "從水溫與注水節奏，記錄一杯咖啡的變化。",
  "section": "生活筆記",
  "body": [
    { "heading": "先固定水溫", "text": "這次先固定水溫，再調整注水節奏，讓兩杯的差異比較容易辨認。" },
    { "heading": null, "text": "下一次會沿用相同豆量，觀察研磨刻度的影響。" }
  ],
  "position": 0
}'
BLOG_CREATE_KEY=$(node -p 'crypto.randomUUID()')

BLOG_CREATED=$(curl -sS -X POST "$BLOG_URL/api/v1/content/articles" \
  -H "Authorization: Bearer $BLOG_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $BLOG_CREATE_KEY" \
  --data "$BLOG_ARTICLE")
printf '%s\n' "$BLOG_CREATED"
```

**檢查點：** HTTP 成功狀態是 `200`，JSON 的 `data.status` 是 `draft`、`data.publishedAt` 是 `null`，而 `data.id` 是新文章的 UUID。保留這個 ID，後面編輯與發布都使用它：

```bash
BLOG_ARTICLE_ID=$(printf '%s' "$BLOG_CREATED" | node -e '
let text = "";
process.stdin.on("data", chunk => text += chunk);
process.stdin.on("end", () => {
  const result = JSON.parse(text);
  if (!result.success || !result.data?.id) {
    console.error("建立失敗，請先檢查上一個回應。");
    process.exit(1);
  }
  process.stdout.write(result.data.id);
});')
```

若建立失敗，先修正錯誤再往下。相同 `kind` 不能重複使用同一個 `slug`；已經做過這個練習時，可以改成 `weekend-coffee-2`，並同步替換後面的公開網址。若只是剛才的請求逾時而不知道有沒有成功，保留原本 payload 與 `BLOG_CREATE_KEY` 重試同一個動作；不要先換一把 key 再建立一次。

訪客此時還讀不到草稿：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$BLOG_URL/journal/weekend-coffee"
```

**預期：`404`。** 若這是唯一一篇 journal，列表 `/journal` 也會回 `404`，不是空白列表頁。管理 API 仍然讀得到它：

```bash
curl -sS -H "Authorization: Bearer $BLOG_TOKEN" \
  "$BLOG_URL/api/v1/content/articles/$BLOG_ARTICLE_ID"
```

輸入限制也會影響你之後的編輯器：slug 只收小寫英文、數字與連字號；標題最多 200 字、摘要最多 500 字；本文最多 60 段，每段文字最多 4,000 字且不能空白。`kind` 建立後不能用 update 改掉。`section` 是顯示用文字，不會自動建立分類篩選。

來源：[建立時固定為草稿](../../packages/platform/content/src/commands.ts#L15)、[輸入限制](../../packages/platform/content/src/dto.ts#L5)、[查無公開文章與空列表](../../packages/platform/content/src/pages.ts#L97)、[草稿／發布回歸案例](../../tests/integration/content-domain.test.ts#L37)。

## 4. 編輯，再發布給訪客

文章的 update 使用 **POST**，不是 PATCH。URL 帶文章 ID，body 只送要修改的欄位；以下把摘要改得更明確：

```bash
BLOG_UPDATE_KEY=$(node -p 'crypto.randomUUID()')
curl -sS -X POST "$BLOG_URL/api/v1/content/articles/$BLOG_ARTICLE_ID" \
  -H "Authorization: Bearer $BLOG_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $BLOG_UPDATE_KEY" \
  --data '{"summary":"固定水溫後，對照兩種注水節奏的手沖紀錄。"}'
```

**檢查點：** 摘要更新了，`status` 仍是 `draft`。`updateArticle` 不負責發布。空物件會因為沒有任何變動欄位而被拒絕；更新 `body` 時須送完整的新段落陣列。

確認內容後，才送出發布：

```bash
BLOG_PUBLISH_KEY=$(node -p 'crypto.randomUUID()')
curl -sS -X POST "$BLOG_URL/api/v1/content/articles/$BLOG_ARTICLE_ID/publish" \
  -H "Authorization: Bearer $BLOG_TOKEN" \
  -H "Idempotency-Key: $BLOG_PUBLISH_KEY"
```

**檢查點：** `data.status` 變成 `published`，`data.publishedAt` 有時間。接著用無憑證的請求確認公開結果：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$BLOG_URL/journal"
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$BLOG_URL/journal/weekend-coffee"
```

兩個都應回 `200`。在瀏覽器打開 `/journal`，應看見「週末手沖筆記」與新摘要；點標題能進單篇，看到兩段正文。Base 的預設主導覽也有「生活誌」，只有存在已發布 journal 時才顯示這個入口。

列表每頁 12 篇，以 `position` 小的排前面，相同時才依發布時間由新到舊排序。資料足夠時可用 `/journal?page=2`；沒有該頁資料會回 `404`。因此將所有文章的 `position` 留成 `0`，就能先採用發布時間排序。

::: warning 已發布文章的編輯會直接公開
目前沒有「已發布版本 + 另一份待審草稿」的雙版本模型。對已發布文章呼叫 update，狀態仍然是 published，訪客會讀到更新後內容。要先離線修稿，請先收回草稿；這段期間公開文章會回 404。
:::

來源：[POST 路由](../../apps/api/src/controllers/content.controller.ts#L66)、[update 與 publish 的責任](../../packages/platform/content/src/commands.ts#L17)、[公開列表分頁](../../packages/platform/content/src/pages.ts#L122)、[排序](../../packages/platform/content/src/repository.ts#L17)、[預設導覽的顯示條件](../../packages/releases/base/src/navigation.ts#L4)。

## 5. 收回草稿，驗證公開邊界

這一步會把剛才的文章從公開網站收回，資料仍保留在管理端。

```bash
BLOG_UNPUBLISH_KEY=$(node -p 'crypto.randomUUID()')
curl -sS -X POST "$BLOG_URL/api/v1/content/articles/$BLOG_ARTICLE_ID/unpublish" \
  -H "Authorization: Bearer $BLOG_TOKEN" \
  -H "Idempotency-Key: $BLOG_UNPUBLISH_KEY"

curl -sS -o /dev/null -w '%{http_code}\n' \
  "$BLOG_URL/journal/weekend-coffee"
```

**檢查點：** 管理回應變成 `draft`、`publishedAt: null`，公開單篇回 `404`。用第 3 步的帶憑證 GET 仍能讀回文章。如果想把練習結果留在公開網站，重新執行第 4 步的發布命令，為這次新動作產生新的 `BLOG_PUBLISH_KEY`。

| 動作完成後 | 管理 API | 公開單篇 | 公開列表 |
| --- | --- | --- | --- |
| 建立草稿 | 讀得到 draft | 404 | 沒有這篇 |
| 編輯草稿 | 讀得到新內容 | 404 | 沒有這篇 |
| 發布 | 讀得到 published | 200 | 包含這篇 |
| 編輯已發布文章 | 讀得到新內容 | 200，內容已更新 | 摘要等欄位跟著更新 |
| 收回草稿 | 讀得到 draft | 404 | 移除這篇 |

公開安全性由 content query 守住：列表固定呼叫 `commerce.content.listPublishedArticles`，單篇固定呼叫 `commerce.content.getPublishedArticle`。它們在資料存取時就要求 `status = published`。不要在自訂頁面改用能讀草稿的管理 query，再期待 Theme 自行過濾。

來源：[公開 query](../../packages/platform/content/src/queries.ts#L12)、[資料庫 published 條件](../../packages/platform/content/src/repository.ts#L30)、[收回處理](../../packages/platform/content/src/commands.ts#L23)、[生命週期測試](../../tests/integration/content-domain.test.ts#L37)。

## 6. 看懂這個 Blog 如何組起來

剛才的操作走了兩條路：

```text
作者：curl / Admin
  → POST /api/v1/content/articles/:id/publish
  → commerce.content.publishArticle
  → content_articles：status = published

訪客：GET /journal/weekend-coffee
  → commerce.content.journalArticle 的 page resolver
  → commerce.content.getPublishedArticle({ kind: 'journal', slug })
  → Theme 的 commerce.content.journalArticle renderer
  → HTML
```

HTTP controller 只把請求交給 command，content 擁有發布狀態與資料。page resolver 決定這個網址要讀哪種文章，Theme 接收已解析的 view，把它排成 HTML。這就是擴充時要保留的分工。

依據：[controller → command](../../apps/api/src/controllers/content.controller.ts#L79)、[command → 資料更新](../../packages/platform/content/src/commands.ts#L20)、[page → 公開 query](../../packages/platform/content/src/pages.ts#L97)、[journal page](../../packages/platform/content/src/pages.ts#L192)、[renderer 註冊](../../packages/themes/base/src/index.ts#L266)。

### 沿著 renderer 找到可以換外觀的位置

先用閱讀程式確認責任邊界，不必修改共用的 Base Theme：

1. 打開 [`contentPages.journal` 的 page 定義](../../packages/platform/content/src/pages.ts#L178)，找到 `path: '/journal'`、page ID `commerce.content.journalList`，以及 `resolve: articleListView('journal', '/journal')`。
2. 到 [Base Theme 的 renderer 對照表](../../packages/themes/base/src/index.ts#L266)，找到同一個 page ID。它指向 `renderArticleList`。
3. 讀 [`renderArticleList`](../../packages/themes/base/src/index.ts#L125)，對照瀏覽器的 `/journal`：`labels.journal` 提供「生活誌」標題；`view.articles` 產生文章列；`view.pagination` 提供前後頁連結。這個函式沒有更新發布狀態，也沒有自行查詢資料庫。

**檢查點：** 現在你應能指出：要換文章列表的排版，自己的 Theme 接手哪個 renderer；要換 URL，必須由哪個 page 定義承擔。導覽名稱仍由 site 的資料提供，單篇標題來自文章資料，不能在 Theme 硬編另一份來源。

要親自擴充，接著做[擴充一個功能](./extending-a-feature.md)與[Extension 實作練習](./extension-lab.md)。那裡會處理你自己的程式與 Release 接線。本篇先保留現有網站，避免把改動共用 Base Theme 誤當成獨立品牌的擴充方式。Base 的 storefront projection 目前只提供 `base` 與 `editorial`，ReleaseDefinition 也會驗證選項；光新增檔案或在設定填任意 Theme ID 不會自動載入它。

來源：[列表 renderer](../../packages/themes/base/src/index.ts#L125)、[Base／Editorial 共用 renderer](../../packages/themes/base/src/index.ts#L250)、[ThemeContext 的導覽責任](../../packages/platform/kernel/src/theme.ts#L47)、[Base 可選 Theme](../../packages/releases/base/src/storefront.ts#L5)、[Base selection 驗證](../../packages/releases/base/src/definition.ts#L37)。

### 哪些需求開始需要新程式

| 需求 | 目前能做什麼 | 後續實作的邊界 |
| --- | --- | --- |
| 改字體、文章版面、列表卡片 | 改 Theme renderer 與樣式 | 保留已發布內容的 view 與 query |
| 改成 `/blog` 網址 | 現有路由是 `/journal` | 自訂模組 page 與 Theme，並處理舊網址／canonical／feed 連結；只改 href 不會新增路由 |
| 標籤與篩選 | `section` 只能顯示文字 | 自訂模組擁有標籤資料、關聯與查詢，再組入 Release |
| 留言、審核與反垃圾 | 現有 contact 是聯絡訊息 | 自訂模組擁有留言生命週期、權限與公開查詢 |
| 全文搜尋 | 列表只有種類、分頁等既有輸入 | 定義搜尋索引與公開查詢，確保草稿／收回後的內容不外洩 |
| Markdown 或富文字編輯器 | 現有本文是 `{ heading, text }[]` | 編輯器先轉成既有段落契約；需要新格式時另訂儲存與安全渲染規則 |

這張表是後續開發的切分建議，不代表倉庫已提供這些 Blog 功能。新增領域行為時，以自己的模組或 Extension 承擔資料與規則，透過 Release 組合；不要為單一 Blog 改 Core，也不要直接讓 Theme 讀寫其他模組的資料表。

## 已經有 Commerce 後台的話

只有正在跑 Commerce、且已有操作者帳號的讀者使用這條路；它不屬於 Base 教學的必要步驟。登入你的 Commerce `/admin`，進入「品牌內容」，對應位置是 `/admin/#/brand-content`。頁面讀取需要 `content:read`，發文動作需要 `content:write`。

1. 選「新增內容」，類型選 `journal`（生活誌）。使用第 3 步的 slug、標題、摘要與段落，配圖先選「不配圖」。
2. 本文用空行分段；若要小標題，第一行寫 `## 先固定水溫`，下一行才寫該段文字。這是後台轉成段落陣列的輸入格式，並非完整 Markdown 語法。
3. 建立後先確認狀態為草稿。按「編輯」可以修內容；種類建立後會鎖住。
4. 開文章列的操作選單，選「發布」。用未登入的瀏覽器視窗開 `/journal/:slug`，確認內容可讀。
5. 在同一個操作選單選「收回草稿」，公開網址應回 404。已發布時直接編輯也會立即更新公開內容，與 API 主線相同。

後台呼叫的仍是同一組 create、update、publish、unpublish HTTP API；API client 會附上 session cookie、CSRF header 與動作的 idempotency key。如果操作顯示結果未知，使用畫面提供的原操作重試，先確認結果再發起下一個新動作。

來源：[Commerce 後台 route](../../packages/releases/commerce/src/admin.tsx#L145)、[本文轉換](../../apps/admin/src/pages/BrandContentPage.tsx#L19)、[新增表單](../../apps/admin/src/pages/BrandContentPage.tsx#L497)、[編輯與不可變的種類](../../apps/admin/src/pages/BrandContentPage.tsx#L624)、[發布／收回選單](../../apps/admin/src/pages/BrandContentPage.tsx#L301)、[API client](../../apps/admin/src/api.ts#L513)。

## 完成檢查與本篇驗證範圍

照做後，應能自己確認三件事：帶憑證能管理草稿；無憑證只有 published 文章可讀；收回後公開網址立刻失效。這比只看到一張文章頁更能證明你接對 content 的公開邊界。

本篇的步驟以現有原始碼與整合測試案例核對。撰寫文件時沒有代為啟動網站、簽發 token 或實際執行這套發文流程，測試案例的存在也不等於本篇已做過端到端驗證。可參考 [content 生命週期案例](../../tests/integration/content-domain.test.ts#L37)、[Base 的內容 HTTP 案例](../../tests/integration/base-release.test.ts#L186) 與 [storefront 內容案例](../../tests/integration/storefront-content.test.ts#L26)。

練習用 token 不再需要時，可以撤銷；它不會刪除文章：

```bash
docker compose -p storeweave-learn -f compose.base.yaml exec api storeweave token:revoke blog-local
unset BLOG_TOKEN
```

來源：[撤銷 CLI](../../tools/cli/src/main.ts#L583)。下一課：[擴充一個功能](./extending-a-feature.md)，把這裡辨認出的責任邊界用在自己的需求上；也可以先讀[介面與後台資料流](../architecture/interfaces-and-admin.md)，看同一套內容規則如何接到其他入口。
