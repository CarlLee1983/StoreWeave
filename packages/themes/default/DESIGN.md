# Default Theme 顧客前台設計規格

**狀態：** 所有目前有 Theme DTO 支援的顧客頁面已實作：共用 shell、同源字型交付、商品瀏覽、購物車、既有的建立訂單確認、登入／帳戶與訂單紀錄。建立訂單頁不新增付款或物流 UI；本文件不是 Admin 的設計規格，也不變更既有 API。

## 1. 目的與完成條件

Default Theme 要讓顧客能在不依賴 JavaScript 的情況下，辨識可購買商品、加入購物車、核對金額、登入並完成既有的結帳流程。視覺以示範品牌「織日選物／Woven Day」為基礎：溫暖、克制、價格與狀態清楚。

本規格完成時，實作者應能確認下列事項：

- 每個商品畫面只呈現目前 Theme 資料介面可支持的事實。
- 商品詳情的加入購物車、購物車調整與結帳，保留既有 SSR 表單、依 session 狀態輸出的 CSRF 欄位與伺服器端驗證。
- Noto Sans TC 與 Noto Serif TC 是確定的 Google Fonts 字體來源；正式頁面不在顧客 session 中向第三方字型 CDN 發出請求。
- 在 360px 寬度與桌面寬度都能完成瀏覽、加車與結帳；焦點、錯誤與不可購買狀態可感知。

不在本次範圍的是：重做 apps/admin、增加商品圖片或分類 API、改變付款提供者、加入 JavaScript 購物車，或以原型假資料取代 Commerce Core 的交易結果。

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

目前商品介面只保證 id、sku、name、nullable description、priceCents、currency 與 available。available 是可售數量或 null，不是布林值：null 不顯示庫存數量但仍可購買，正數顯示可售件數，零或負數才是售完。沒有商品媒體、slug、分類、標籤、變體選項、評分或配送承諾。因此正式商品卡不可把原型室內照、虛構材質或分類名稱偽裝成真實商品資訊。

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
| 錯誤 | state-danger | #A83232 | 表單錯誤、無法提交與失效品項 |

版面採單欄優先：主要內容最大寬度 72rem，正文留白使用 1rem、1.5rem、2.5rem、4rem 節奏。購物車與結帳在寬螢幕可用內容／摘要兩欄；在窄螢幕摘要回到內容之後，主要提交按鈕仍完整可見。按鈕與輸入框需有 0.5rem 以上圓角、明確 focus ring，且不以顏色作為唯一狀態訊號。

### 字體：Google Fonts 作為來源，正式環境自託管

字體決策如下：

| 角色 | 字體 | 字重 | 用途 |
| --- | --- | --- | --- |
| 介面與正文 | Noto Sans TC | 400、500、600、700 | 導覽、表單、金額、說明、狀態 |
| 品牌與長標題 | Noto Serif TC | 400、500、600 | 頁面標題、商品名稱、編輯式引言 |

原型可透過 Google Fonts CSS API 載入上述字型，並帶 display=swap，以快速確認中文字形與層級。正式 Theme 則必須將經確認的 WOFF2 字型檔隨應用程式靜態資產發布，使用相同 family 名稱與 generic fallback。這是本規格新增的資產邊界：現有 layout 已禁止第三方可執行 script；本規格進一步要求帶有登入或購物車 session 的頁面，也不新增 fonts.googleapis.com 或 fonts.gstatic.com 的執行期依賴。

正式樣式的字型 stack 與數字規則：

~~~css
--font-sans: "Noto Sans TC", ui-sans-serif, -apple-system, BlinkMacSystemFont,
  "Segoe UI", "PingFang TC", sans-serif;
--font-serif: "Noto Serif TC", "Songti TC", "Times New Roman", serif;

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

商品媒體是未來的擴充接縫。要加入真實商品圖片時，先把媒體識別、alt text、排序與可公開存取規則納入 ThemeProductView；完成資料遷移與來源審核後，商品卡才可以使用圖片。原型中的 Unsplash 圖片不屬於這個介面。

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

## 6. 共用元件與內容規則

| 模組元件 | 輸入 | 輸出與限制 |
| --- | --- | --- |
| Storefront shell | ThemeContext 與頁面已提供的登入／購物車摘要資料 | 品牌、商品入口、帳戶入口、購物車入口；不依賴 client-side menu |
| Product summary | ThemeProductView、showSku | 名稱、價格、描述、可售性、連結；不假設媒體或分類 |
| Quantity form | product id、available、session 存在時的 CSRF | 標準 POST 表單、label、錯誤與送出結果 |
| Cart summary | Cart view | 商品小計、調整明細、總額與門檻／移除 notice；金額順序固定 |
| Checkout summary | Cart 或 checkout view、customer email | 訂單品項、通知 email、總額、提交與回購物車連結 |
| Feedback region | notice、error、success | 具角色或 live region 的文字訊息，說明原因與下一步 |

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
2. 移除遠端字型 CSS，改由應用程式靜態資產提供 WOFF2。
3. 移除所有 demo 商品、價格與圖片；只渲染 controller 提供的資料。
4. 將每個購買動作改為現有 SSR POST 表單；session 存在時保留 CSRF，匿名 guest cart 則保留同源寫入保護、server notice 與 redirect。
5. 對商品、購物車、結帳與訂單執行既有 integration tests，再做 360px 與桌面瀏覽器檢查。

## 9. 實作與驗證順序

1. 已完成 Foundation：建立共用 shell、token、同源 Noto WOFF2 與靜態資產發布邊界，且不改變 Theme 公開介面。
2. 已完成 Catalog：完成商品列表與詳情，僅使用現有 Product view 欄位與 POST /cart/items。
3. 已完成 Purchase presentation：購物車與建立訂單確認頁採內容／摘要兩欄，在窄螢幕改為可讀的逐項內容；保留登入、依 session 狀態輸出的 CSRF、cartId 與冪等行為。
4. 已完成 Account presentation：登入、重設密碼、訂單、優惠券、購物金與個人資料使用相同 shell、狀態與字體系統。
5. 下一個後端契約切片：付款方式、付款 provider redirect／webhook、地址使用規則、配送選項／費用與追蹤狀態；先定義 request/response 與失敗狀態，再在 Theme 加入 UI。

這條順序保持每個模組的介面小而清楚：視覺調整不滲入交易規則；若資料契約真的需要擴張，便在 Platform 與 Theme 的接縫上明確演進，而不是把一次性原型變成永久依賴。
