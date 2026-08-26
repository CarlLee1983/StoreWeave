# Default Theme 顧客前台設計規格

**狀態：** 顧客前台的頁面已全部實作：共用 shell、商品瀏覽與型錄、購物車與結帳、付款與物流呈現、
登入／帳戶與訂單紀錄，以及品牌內容四頁與聯絡我們。字型走 Google Fonts CDN（ADR 0026），
不是同源交付——本文件早期寫的是後者，以 ADR 為準。本文件不是 Admin 的設計規格。

## 1. 目的與完成條件

Default Theme 要讓顧客能在不依賴 JavaScript 的情況下，辨識可購買商品、加入購物車、核對金額、登入並完成既有的結帳流程。視覺以示範品牌「織日選物／Woven Day」為基礎：溫暖、克制、價格與狀態清楚。

Default Theme 的旗艦示範店是「織日選物／Woven Day」：它可以發布品牌立場、選品觀點與生活誌，讓首頁不只是一份商品清單。這些是具名品牌的編輯內容，和商品事實分開；商品卡與詳情仍只呈現 Theme DTO 已提供的名稱、SKU、描述、價格與可售狀態。非織日選物的商店不會自動繼承其故事或專欄。

本規格完成時，實作者應能確認下列事項：

- 每個商品畫面只呈現目前 Theme 資料介面可支持的事實。
- 商品詳情的加入購物車、購物車調整與結帳，保留既有 SSR 表單、依 session 狀態輸出的 CSRF 欄位與伺服器端驗證。
- Noto Sans TC 由 Google Fonts CDN 提供（unicode-range 分片，一般頁面數十 KB）；標題的 serif 走系統字型堆疊。隱私取捨與被排除的替代方案見 `docs/adr/0026-storefront-fonts-from-google-cdn.md`。
- 在 360px 寬度與桌面寬度都能完成瀏覽、加車與結帳；焦點、錯誤與不可購買狀態可感知。

不在本次範圍的是：重做 apps/admin、增加商品圖片或分類 API、改變付款提供者、加入 JavaScript 購物車，或以原型假資料取代 Commerce Core 的交易結果。織日選物的品牌故事與生活誌可使用 Theme 內建、同源提供的原創編輯照片；它們不是商品媒體，也不會依商品名稱推測商品外觀。

## 2. 模組、介面與接縫

顧客前台可視為一個 Theme 模組。它接收 Platform 已組裝好的 ThemeContext、ThemeProductView、購物車與訂單 view；它的輸出是可提交的語意 HTML。Theme 不直接讀資料庫，也不自行計算可收取金額。

~~~text
Storefront Controller
        │  已驗證的資料與狀態
        ▼
Theme 介面（Context / Product / Cart / Order views）
        │  可替換的呈現接縫
        ▼
Default Theme SSR renderer
        │
        ▼
HTML、標準表單、可存取的狀態提示
~~~

這是本設計最重要的接縫：

- Platform 擁有資料真實性、庫存、價格、登入、CSRF、冪等與訂單寫入。
- Theme 擁有內容層級、版面、文案、色彩、字體與可近用的操作回饋。
- 若新體驗需要新資料，先擴充 versioned Theme DTO 與 Controller；不可在 Theme 中猜測欄位，或由頁面呼叫其他內部資料來源。

目前商品介面只保證 id、sku、name、nullable description、priceCents、currency 與 available。available 是可售數量或 null，不是布林值：null 不顯示庫存數量但仍可購買，正數顯示可售件數，零或負數才是售完。DTO 裡**沒有** slug、分類、標籤、變體選項、評分或配送承諾，Theme 不得虛構它們。

商品照片是例外，而且是刻意的例外：它由 Theme 自己以 SKU 為 key 的**封閉對照表**提供（`src/artwork.ts`），不在 DTO 裡。這個分界的重點不是「有沒有圖」，而是**商家資料永遠不會變成公開檔案路徑**——對照表查不到的 SKU 就沒有圖，不會退回用商品名稱或 SKU 去拼一個路徑。要改成真正的商品媒體（商家上傳、可排序、有 alt text），得先把媒體識別與可公開存取規則納入 ThemeProductView。

## 3. 視覺系統

### 品牌 token

下表是 Default Theme 的基準，而不是新增跨 Theme 的平台設定。既有 accentColor 仍是品牌主色的輸入；其他 token 由 Default Theme 的樣式層統一維護。

| 用途 | Token | 基準值 | 使用規則 |
| --- | --- | --- | --- |
| 頁面背景 | surface-canvas | #F7F3ED | 大面積底色，不承載低對比文字 |
| 元件背景 | surface-raised | #FFFDFC | 商品、摘要與表單區塊 |
| 主要文字 | ink-strong | #2B2520 | 標題、價格、關鍵內容 |
| 次要文字 | ink-muted | #675D55 | 輔助說明，不單獨傳達錯誤或可售性 |
| 邊框 | line-subtle | #DCD1C5 | 卡片、輸入與區塊分隔 |
| 主要行動 | action-primary | Theme accentColor，預設 #8C3E28 | 白字或深色字須通過對比檢查 |
| 成功／可用 | state-success | #36684A | 仍以文字說明可用意義 |
| 警示 | state-warning | #8A5A12 | 庫存、到期與金額變化提醒 |
| 錯誤 | state-danger | #A83232 | 邊框與圖示；文字用 state-danger-ink |
| 錯誤文字 | state-danger-ink | #7F1D1D | 送出失敗等訊息的文字色 |
| 錯誤底色 | state-danger-surface | #FFF4F3 | 錯誤訊息塊的底，不單獨承載意義 |
| 焦點 | state-focus | #17673C | 鍵盤焦點外框，不可移除 |
| 次要底色 | surface-muted / surface-tint | #EEE7DE / #F4ECE2 | 區塊分層，不承載低對比文字 |
| 最弱文字 | ink-faint | #968B81 | 僅用於輔助標記，不傳達必要資訊 |
| 反白文字 | ink-inverse | #FFF | 深色底上的文字 |
| 強邊框 | line-strong | #B8ABA0 | 需要明確分界時 |
| 主色衍生 | accent-hover | 由 accentColor 推導 | 不另外硬編顏色，隨品牌主色變動 |

值的權威來源是 `src/layout.ts` 的 `:root`；這張表若與它不一致，以程式碼為準。
| 錯誤 | state-danger | #A83232 | 表單錯誤、無法提交與失效品項 |

版面採單欄優先：主要內容最大寬度 72rem，正文留白使用 1rem、1.5rem、2.5rem、4rem 節奏。購物車與結帳在寬螢幕可用內容／摘要兩欄；在窄螢幕摘要回到內容之後，主要提交按鈕仍完整可見。按鈕與輸入框需有 0.5rem 以上圓角、明確 focus ring，且不以顏色作為唯一狀態訊號。

### 字體：Google Fonts 作為來源，正式環境自託管

字體決策如下：

| 角色 | 字體 | 字重 | 用途 |
| --- | --- | --- | --- |
| 介面與正文 | Noto Sans TC | 400、500、600、700 | 導覽、表單、金額、說明、狀態 |
| 品牌與長標題 | 系統 serif（`Songti TC` 等） | 由系統字型提供 | 頁面標題、商品名稱、編輯式引言 |

字型透過 Google Fonts CSS API 載入，帶 `display=swap` 與兩個 `preconnect`。自託管整包 Noto Sans TC 是 5.42 MB，分片後的 CDN 交付約數十 KB，差距兩個數量級，因此接受把顧客 IP 交給 Google 的取捨（ADR 0026）。第三方**可執行 script** 仍然完全禁止：這個 Theme 不輸出任何 `<script>`。

正式樣式的字型 stack 與數字規則：

~~~css
--font-sans: "Noto Sans TC", ui-sans-serif, -apple-system, BlinkMacSystemFont,
  "Segoe UI", "PingFang TC", sans-serif;
--font-serif: "Songti TC", "Noto Serif CJK TC", "Source Han Serif TC", "Times New Roman", serif;

.price,
.order-total,
.quantity-input {
  font-variant-numeric: tabular-nums;
}
~~~

正文基準為 1rem／1.6；介面輔助字不小於 0.8125rem；商品名稱 1.25rem 至 1.75rem；主要頁首可使用 2.25rem 以上的 serif，但不以過小字或極細字重建立層級。字型檔、字重範圍、license 與載入宣告要在 implementation worktree 中一併加入，不能只在 HTML 引用遠端網址。

## 4. 可下單的商品呈現

### 商品列表

首頁是可購商品的入口，而不是帶有購物假象的型錄。每張商品卡至少包含：

1. 可點擊的商品名稱，連到 GET /p/:id。
2. 依 currency 格式化的 priceCents。
3. available 為 null 時不顯示庫存數量；大於零時顯示可售件數；零或負數時才顯示「已售完」。
4. 可選的 description 摘要；沒有描述時不保留空白佔位。
5. SKU 只在 showSku Theme option 啟用時呈現。

列表頁的價格是瀏覽資訊，不是保證的最終報價。卡片不提供依賴假設資料的尺寸、材質、色票、分類 chips 或直接 quick-add；顧客先進入商品詳情確認名稱、價格、可售狀態與數量。

### 商品詳情

商品詳情是加入購物車的唯一主要入口。available 為 null 或大於零時，表單需送出：

~~~text
POST /cart/items
productId
quantity（正整數）
有 session 時，輸出 Context 提供的 hidden CSRF token
~~~

未登入訪客沒有 session token，仍可用同源的標準 POST 加入 guest cart；Platform 以 Origin 與 Sec-Fetch-Site 檢查匿名寫入。Theme 不可因 token 不存在而隱藏或阻擋這條路徑。

available 為 null 時保留可提交表單且不顯示庫存數量；大於零時顯示可售件數，數量輸入的前端 max 不超過該數量；零或負數時才停用提交並顯示「已售完」。前端數量限制只是輔助，伺服器仍是最終驗證者。伺服器回傳的 notice 或 error 必須出現在表單前方，使用可被輔助技術辨識的狀態區，而不是只改按鈕顏色。

`/storefront-assets/` 只提供版本隨附、檔名封閉的 Theme 資產——商品照片與品牌內容的編輯照片都走它。它不能成為商家上傳檔或任意檔案的公開路徑；文章指名照片時存的也只是一個 key，不是路徑（ADR 0034）。

## 5. 購物車、結帳與訂單的真實性

| 旅程 | Theme 的責任 | Platform 的責任 |
| --- | --- | --- |
| 加入購物車 | 顯示可用數量輸入、表單與結果訊息 | 驗證商品與數量，更新 guest 或 customer cart |
| 檢視購物車 | 依 Cart view 排列品項、小計、調整、總額與失效提示 | 重新計價、檢查目前可售性；購物車不保留庫存 |
| 修改購物車 | 提供既有 POST 操作與每列可理解的結果 | 寫入數量、移除、優惠碼與購物金變動 |
| 結帳 | 呈現不可誤解的摘要與單一提交動作 | 要求已登入 customer、驗證 CSRF、建立具冪等性的訂單 |
| 訂單詳情 | 呈現 server 提供的訂單與付款狀態 | 保持訂單、付款與庫存扣減的真實狀態 |

必須保留的流程事實：

- 未登入顧客可以使用 cookie 型 guest cart；進入 GET /checkout 時，既有行為會導向登入，登入後再回到結帳。
- checkout 的 POST 必須帶著 Context 提供的 CSRF token 與 cartId。訂單冪等鍵由伺服器根據 actor 與 cart 產生，Theme 不自行產生或重用隨機鍵。
- 購物車顯示的是目前重新計算的價格與可售性，不承諾加入車時的庫存或價格。庫存不足、折扣失效、購物金變動與空車都要完整顯示 server notice。
- 前台只能把成功導向訂單頁視為「已建立訂單」；付款是否完成必須依訂單 view 的付款狀態呈現，不能由按鈕文案推論。

這些約束使設計未來可接入真實下單，而不是只把按鈕做成看似可點擊的 mock。任何新的運費、地址、物流、付款方法或商品變體需求，都必須先定義 request/response 契約與失敗狀態，再設計 UI。

品牌內容適用同一條規則的另一面：版型可以由 Theme 決定，**內容不行**。文章、消息與問答都來自
content 模組的 DTO，Theme 不內建任何具名品牌文字；`src/` 底下再出現一份品牌內容常數，
就是 ADR 0033 被推翻的訊號。

新增品牌版型時對應的樣式 class 群在 `src/layout.ts`：`.news-page` / `.news-list` / `.news-row`、
`.faq-page` / `.faq-group` / `.faq-list` / `.faq-item`、`.contact-page` / `.contact-form` /
`.contact-done` / `.contact-hp`、以及跨版型共用的 `.article-block`。**每一個輸出的 class 都要有樣式**——
首頁曾經有六組只剩 CSS 沒有 render 的區塊，文件照著它們描述了不存在的畫面。

## 6. 共用元件與內容規則

| 模組元件 | 輸入 | 輸出與限制 |
| --- | --- | --- |
| Storefront shell | ThemeContext（含 `publishedContentKinds`）與頁面已提供的登入／購物車摘要資料 | 品牌、商品入口、帳戶入口、購物車入口；不依賴 client-side menu。品牌內容的入口**只在該類內容有已發布文章時**出現——Theme 不自己判斷哪一頁有內容，由 Storefront 告知（ADR 0033） |
| Product summary | ThemeProductView、showSku | 名稱、價格、描述、可售性、連結；不假設媒體或分類 |
| Quantity form | product id、available、session 存在時的 CSRF | 標準 POST 表單、label、錯誤與送出結果 |
| Cart summary | Cart view | 商品小計、調整明細、總額與門檻／移除 notice；金額順序固定 |
| Checkout summary | Cart 或 checkout view、customer email | 訂單品項、通知 email、總額、提交與回購物車連結 |
| Feedback region | notice、error、success | 具角色或 live region 的文字訊息，說明原因與下一步 |
| Brand article | ThemeArticleView | 標題、欄目、摘要與段落區塊；帶 `heading` 的區塊才輸出小標。`imageKey` 查不到對應照片時走無圖版型，不讓缺圖弄壞整頁 |
| Article list | ThemeArticleListView | 生活誌是照片卡格線、最新消息是日期式清單、常見問題依 `section` 分組；三者共用同一份資料形狀，差別只在版型 |
| Contact form | ThemeContactView、session 存在時的 CSRF | 標準 POST 表單、錯誤回填、送出結果頁；含視覺上完全移出畫面的 honeypot 欄位（`.contact-hp`），它必須看不見也 tab 不到，否則真人會被當成機器人靜靜丟掉 |

CTA 命名採具體動詞：加入購物車、更新數量、套用優惠碼、前往結帳、建立訂單。不要用「立即擁有」、「限時搶購」等無法由資料證明的促銷語。空狀態也需提供下一步，例如「購物車目前沒有商品，返回商品列表」。

## 7. 可近用與響應式驗收

- 所有互動元素使用 button、a、label、input、form 等原生語意；不把 div 當按鈕。
- 鍵盤焦點順序跟視覺閱讀順序一致，焦點樣式在亮／暗底上都可見。
- 錯誤使用文字、圖示與顏色三者中的至少兩種；不要只用紅框。
- 價格、折扣、總額、負數調整與貨幣格式由共用 formatter 統一輸出。
- 在 360px 寬度沒有橫向捲動；數量控制與結帳提交按鈕的點擊目標至少約 44px。
- 在無 JavaScript、慢速字型載入與伺服器回傳錯誤時，關鍵交易步驟仍可完成或得到可理解的結果。

## 8. 原型與正式實作的界線

storefront-prototype 只用於選擇首頁的敘事、型錄或拼貼層級。它可在本機用 Google Fonts CSS API 與已授權的公開圖像快速驗證視覺，但它的記憶體互動、產品名稱、價格和圖片都不是平台資料。

轉入正式 Theme 前，要逐項替換：

1. 將原型版型對應至真實 Theme renderer 與 ThemeProductView。
2. 移除原型自己的字型引用，改用 layout 的那一份（ADR 0026 決定走 Google Fonts CDN，含它的隱私取捨）。
3. 移除所有 demo 商品與價格；只渲染 controller 提供的資料。照片走 `src/artwork.ts` 的封閉對照表，不是原型的圖。
4. 將每個購買動作改為現有 SSR POST 表單；session 存在時保留 CSRF，匿名 guest cart 則保留同源寫入保護、server notice 與 redirect。
5. 對商品、購物車、結帳與訂單執行既有 integration tests，再做 360px 與桌面瀏覽器檢查。

## 9. 實作與驗證順序

1. 已完成 Foundation：建立共用 shell、token 與靜態資產發布邊界，且不改變 Theme 公開介面。
2. 已完成 Catalog：完成商品列表與詳情，僅使用現有 Product view 欄位與 POST /cart/items。
3. 已完成 Purchase presentation：購物車與建立訂單確認頁採內容／摘要兩欄，在窄螢幕改為可讀的逐項內容；保留登入、依 session 狀態輸出的 CSRF、cartId 與冪等行為。
4. 已完成 Account presentation：登入、重設密碼、訂單、優惠券、購物金與個人資料使用相同 shell、狀態與字體系統。
5. 已完成 Payment / Fulfilment：付款方式與 provider redirect、地址與超商取貨門市、運費與出貨追蹤、發票與退貨。
6. 已完成 Brand content（Spec 0007、ADR 0033／0034）：品牌故事、生活誌、最新消息、常見問題與聯絡我們。
   內容來自 Core 的 content 模組，Theme 只有版型；哪些入口出現在導覽列由 `ThemeContext.publishedContentKinds` 決定，
   Theme 不自己猜哪一頁有內容。

這條順序保持每個模組的介面小而清楚：視覺調整不滲入交易規則；若資料契約真的需要擴張，便在 Platform 與 Theme 的接縫上明確演進，而不是把一次性原型變成永久依賴。
