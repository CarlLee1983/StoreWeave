# StoreWeave domain glossary

## Order

A customer's immutable-priced purchase request. An Order is `pending` until a payment request is made, `payment_processing` while the provider is being contacted, `awaiting_payment` once a deferred method has handed the customer a code to pay later (ADR 0030), `paid` after payment is confirmed, `cancelled` after an explicit cancellation, or `expired` when its payment reservation reaches its deadline.

## Inventory reservation

A temporary claim on sellable stock made for every Order line. It increases `reserved` without reducing `on_hand`; it is committed on payment, or released on cancellation or expiry. `available` is `on_hand - reserved`.

## Payment request

一次對金流商的收款嘗試。它有自己的交易號、狀態與期限，**一張 Order 可以有多次**——付款失敗後重試必須換一個新的交易號，因為金流商那一側的號碼不可重複，失敗單也佔號。Payment request 不是成功的付款；唯一的成功轉換是金流商確認之後、經 `recordPaymentResult` 進來的那一次。Order 的付款狀態是這些嘗試的推導值。

## Customer

一個會下單的人。Customer 擁有生日、會員等級、等級積分與購物金餘額。Customer 與後台操作者共用同一套帳號與 session 機制，但兩者的資料分屬不同模組：帳號只知道「這是一個帳號」，不知道他是顧客還是店員。結帳必須是已登入的 Customer。

## Account

一個可以登入的身分，存在 `platform_users`。帳號只知道「這是一個帳號」——它不知道持有者是顧客、店員還是形象站的會員，那由角色與各模組自己的資料決定。Customer 擴充在帳號旁邊，不是帳號的前提（ADR 0041）。

## Member

Base 的一般人：可以自己註冊、驗證信箱、登入、看自己東西的帳號，但沒有任何商務資料。Member 不是 Customer——base release 裡根本沒有商務資料——兩者也不是同一個角色。一個 release 至多有一個可自助註冊的角色。

## Session

一次登入的持續狀態。認證發生在 Actor 存在之前——那一刻還沒有身分可以檢查權限——所以簽發與解析 session 不是 Command，而是 Interface Adapter 直接呼叫的服務。前台頁面不能自己簽發 session，它把簽發當成渲染的結果交出去（ADR 0047）。

## 顧客前台（Storefront）

顧客與匿名訪客瀏覽商品、管理購物車並完成下單的商店介面。它以建立品牌信任與促成商品探索、結帳為目的，和營運後台（Admin）是不同的產品體驗。

## 品牌內容（Brand Content）

具名商店發布的品牌立場、選品觀點與編輯文章。它用來說明商店的世界觀與閱讀脈絡，不是商品材質、庫存、服務承諾或法律條款的來源；這些事實仍由各自的交易與商品資料決定。

品牌內容是 Content Base Module 的資料，由店家在後台維護，Theme 只負責呈現（ADR 0033、0049）。品牌故事、生活誌、最新消息與常見問題是**同一種東西的四種版型**——一段具名、可發布、有順序的編輯文字——在模型上以 `kind` 區分，不是四個型別。

一篇內容有 `draft` 與 `published` 兩態，未發布的一律不從前台的查詢出得去。`section` 是標題上方的分組字樣（生活誌的欄目、FAQ 的分類），`position` 決定同一種內容的顯示順序，相同時才看發布時間。

文章的段落是**區塊**而不是純文字：一個區塊可以帶自己的標題，品牌故事的章節就是這樣表達的；其餘內容的區塊沒有標題。

文章可以指名一張照片；照片是 Media Base Module 的資產，Content 只保存引用，Theme 只負責呈現。既有 Theme image key 的遷移與回退邊界見 ADR 0034、0048、0049。

## 聯絡訊息（Contact Message）

訪客或會員從前台送出的一則詢問。它與品牌內容同屬一個模組，因為兩者服務同一段顧客動線——讀完之後想問一句話。匿名訪客送得出訊息，登入者的訊息會連到他的顧客身分。

聯絡訊息**不觸發任何寄信**：它落表，然後由後台收件匣處理。「已處理」是一個不可逆的狀態，重複標記會被擋下。

## Cart

一份可變的、尚未定價凍結的購買意圖。Cart 可以屬於一個匿名訪客，也可以屬於一個 Customer；訪客登入後，其 Cart 併入該 Customer 的 Cart。Cart **不預留庫存**——放進 Cart 不保證買得到。Cart 轉成 Order 的那一刻，價格才凍結。

## Adjustment

一筆對價格的具名調整：有金額、有來源、有名稱。Order 與 order line 上的折扣一律以 Adjustment 表達，且**必定分攤到 line**——退貨、開發票與對帳都需要知道每一件商品實際收了多少錢。Order 的總額是商品小計加上所有 Adjustment 的結果，不再等於小計。

## Promotion

一條定價規則：在什麼條件下、對什麼範圍、折多少。Promotion 有優先序與「可否與其他 Promotion 疊加」的旗標。滿額折這類人人適用的活動只需要 Promotion，不需要 Coupon。

## Coupon

一張具名的券，指向某個 Promotion。Coupon 有自己的狀態（已發放、已使用、已過期）。它可以是**實發**的——發到某個 Customer 身上、只有他能用（生日禮券、新會員禮券）；也可以是一組**共用碼**——沒有擁有者，任何知道碼的人都能用（公開折扣碼）。Coupon 的核銷紀錄同時是行銷分析的事實來源。

Coupon 也可以指向一個合作夥伴，成為**行銷碼**——與名人或通路合作發出的共用碼，除了折價之外還把該筆訂單歸因於他。歸因只認結帳時實際輸入的碼，不認連結點擊；一張 Order 最多只能有一個帶歸因的 Coupon。佣金不由系統計算。

## 等級積分（tier points）

累積用來決定會員等級的數值。等級積分不能折抵金額。等級積分以滾動十二個月計算，因此會降級；它與購物金一樣以 ledger 記錄每一筆的時間，等級是 ledger 的推導值。

## 購物金（reward points）

可折抵訂單金額的準貨幣，以分批 ledger 記錄，每一批有自己的有效期；餘額是 ledger 的推導值，不是一個欄位。購物金的累積條件與等級積分不同。折抵永遠是最後套用的 Adjustment，且只作用在商品小計上。訂單取消時，折抵過的購物金與已累積的購物金都以反向分錄回沖，用掉的 Coupon 恢復可用；部分退貨不在目前的模型內。

在任何文件、程式碼與介面中都不單獨使用「點數」二字——它一律是「等級積分」或「購物金」其中之一。

## 會員等級

由等級積分決定的顧客分級。等級不是獨立的折扣系統，它只是定價引擎的一個輸入變數：影響適用哪些 Promotion，以及購物金的累積倍率。

## 運送方式

一種把 Order 送到顧客手上的具名方式：有名稱、運費、免運門檻、單筆金額上限，並指向一個物流商與它的子類型（各家超商或宅配）。運送方式是**店家維護的商業資料**，不是物流商的能力——同一個超商取貨，店家可以收 60 也可以收 0。運費與免運門檻因此不經過定價引擎：折扣與購物金折抵一律不作用在運費上。

Cart 上的運送方式可以是未選；未選時運費是**未知**而不是零。它在 Cart 轉成 Order 的那一刻連同價格一起凍結。

## 出貨

一張 Order 送出去的那一件事。出貨有自己的生命週期——已建單、已出貨、已到店、已完成——以及自己的外部識別碼。目前一張 Order 恰好一筆出貨：缺貨先出一部分、不同商品分開送都不在現在的模型內。

出貨事件只表達領域階段，不轉述物流商的狀態碼；那些留在出貨紀錄與稽核紀錄裡，要看得用查詢，不從事件拿。

## 代收貨款

顧客在取貨當下才付錢的運送方式。錢由物流商代收，**沒有金流訂單**——它是物流單上的一個旗標。因此代收貨款的訂單付清是由物流的取貨回報造成的，不是由金流商確認造成的，而它的庫存預留以天計而不是以分鐘計。

## 選店回填權杖

一張短期、單次的憑證，用來認出「從物流商的選店頁回來的這個請求，要把門市寫回哪一台 Cart」。它存在的原因是選店回傳是**跨站 POST**，而 session cookie 是 `SameSite=Strict`——那個請求身上沒有任何 cookie，系統不知道回來的是誰。權杖只授權寫回門市這一件事，用掉即失效。

## 住宿預訂

**Property**:
接受住宿預訂的單一營業地點，是地址、時區、入住與退房時間及住宿政策的擁有者。第一個 Booking Release
只啟用一個 Property。
_Avoid_: Store、Hotel Account

**Room Type**:
以相同每房最大入住人數、床型、設施與房價出售的一類住宿供應。一個 Room Type 可以有多個可售單位；
第一版不在訂房時指定實體房號。
_Avoid_: Product、SKU、Room

**Room Night**:
某個 Room Type 在 Property 當地日期的一個可售單位。入住日包含、退房日不包含；例如 10 月 1 日入住、
10 月 3 日退房會消耗 10 月 1 日與 10 月 2 日兩個 Room Night。
_Avoid_: Inventory Item、Stock

**Booking Quote**:
依房型、日期、人數與當下價格算出的非持久性試算結果。Booking Quote 不占用 Room Night，也不是價格承諾；
建立 Reservation 時才凍結逐晚含稅價格、幣別、總額與取消政策。
_Avoid_: Cart、Order Quote

**Reservation**:
對一個 Property、一個 Room Type、一段連續住宿日期及該房型一間或多間的住宿承諾。
`pending_payment` 與 `confirmed` 會占用 Room Night；`expired` 與 `cancelled` 不占用。第一版不記錄入住與退房
作業狀態，住宿前、住宿中與已過住宿日期皆由日期推導。
_Avoid_: Order、Booking Order

**Booker**:
建立 Reservation、負責付款並接收通知的人。Reservation 保存 Booker 的聯絡資料快照；Booker 可以連到
Account，但建立 Reservation 不要求登入。
_Avoid_: Customer

**Guest**:
實際入住的人，可以與 Booker 不同。Guest 不是 Account，也不因出現在 Reservation 上而取得登入身分。
_Avoid_: Customer、Member

**Cancellation Policy**:
Reservation 建立時凍結的取消與退款承諾。第一版只支援整筆取消；退款截止時間前可全額退款，截止後不提供
顧客自助取消。

**Late Payment**:
Provider 在 Reservation 已經 `expired` 或 `cancelled` 後才確認成功的收款。Late Payment 不會復活
Reservation 或重新占用 Room Night；它必須被記錄並進入全額退款流程。

**Excess Payment**:
Reservation 已由另一筆付款確認後，另一個 Payment Attempt 又被 Provider 確認成功的額外收款。Excess Payment
不改變 Reservation，必須被記錄並進入全額退款流程。

**Reservation Payment Attempt**:
對一筆 Reservation 發起的一次 Provider 收款嘗試，有自己的唯一 reference、方法、狀態與期限。一筆
Reservation 可以在前一筆明確失敗或到期後重試，但只能有一筆付款成為確認 Reservation 的 winning attempt。

**Reservation Management Token**:
授權匿名 Booker 查看或操作一筆 Reservation 的可撤銷隨機憑證。它與可讀的 Reservation number 分開，
資料庫只保存雜湊，且不放進 Email 或 URL；Reservation number 與 Email 不能取代這張憑證。

**Reservation Access Grant**:
透過 Email 交付的短期、單次簽章憑證，只能兌換成 Reservation Management Token。兌換成功後以安全 cookie
保存管理狀態並轉址到不含憑證的 URL；Access Grant 不能直接執行 Reservation 操作。

---

# 開發流程詞彙

以下不是產品領域的詞，而是這個 repo 怎麼把需求變成程式碼的詞。它們與上面的商務詞彙分屬兩個層次，
放在同一份檔案只是為了讓詞彙有單一出處。決策見 ADR 0051。

## 產品與模組

**Product Release**:
一份可獨立建置、部署並使用獨立資料庫的產品交付物。它選取 Platform、Base Module、Product Module、
Theme 與 Extension 組成可執行應用；Commerce 與 Booking 是不同的 Product Release。
_Avoid_: Core、產品 Core

**Base Module**:
不帶特定產品交易語意、可由不同 Product Release 選用的完整能力。能力只有在至少兩個實際產品中的
領域語意與生命週期一致時，才從產品層提升為 Base Module。
_Avoid_: 共用 Core、萬用模組

**Product Module**:
擁有某個產品領域的資料、規則、流程與公開契約，並由 Product Release 選取的模組。不同產品碰巧都有
付款、庫存或會員，不代表它們必須共用同一個 Product Module。
_Avoid_: Core Module

**Booking Release**:
以住宿預訂為產品領域的 Product Release。第一個 Booking Release 與 Commerce 分開建置、部署與使用資料庫，
並以房型庫存完成搜尋、報價、保留、訂房、付款、確認、取消與後台管理的完整旅程。
_Avoid_: 訂房外掛、Commerce 訂房模式

## Spec

需求與驗收的唯一來源，存在 `docs/specs/`。一份 Spec 描述一個能力要滿足什麼，不描述誰在什麼時候做。
`docs/specs/README.md` 的狀態欄講的是**這份 Spec 的成熟度**：`ready-for-agent` 意思是「已可據以派工」，
不是「還沒做」——七份標著它的 Spec 對應的工作多半早已完成。

## Story

一件被人核准過、有邊界、一個 agent 一次做得完的工作，存在 `specs/stories/<id>/`，ID 形如 `SW-001`。
一張 Story 由 `story.md`（目標、範圍、規則、預期錯誤）與 `acceptance.md`（可勾選的 AC 與證據表）組成，
`task.md` 是人的工作筆記、不是需求來源。Story 的 In Scope 只能碰一個 package 邊界，跨邊界就拆。

Story **不記錄自己現在處於什麼狀態**。`READY`、`IMPLEMENTING`、`VERIFYING`、`REVIEW`、`DONE` 是講事情時
共用的詞，不是寫進檔案的欄位；誰做到哪一步由 Story Driver 從證據推導。

## Story Driver

持有工作圖與執行順序、挑出下一張 Story 並派工的控制平面。它是 PraxisBound 協定的**外部**角色：
協定管一張 Story 怎麼做完並留下證據，Driver 管有哪些工作、誰先誰後、現在該做哪一張。
協定明文把 current state 指給這個角色，所以 Driver **是**持有狀態的那一方——被禁止的是把狀態
寫進 Story 檔案，不是禁止 Driver 記住它。

由誰扮演這個角色尚未選定：候選是既有的 ForgePilot（Go 寫的 Engineering Control Plane，
狀態存 `.forgepilot/state.json`），或在本 repo 自寫一支。選定前 StoreWeave 沒有 Story Driver。
無論由誰扮演，依賴邊界都只有三樣：`specs/stories/` 的目錄契約、`make verify` 這個介面、
以及協定 CLI 的機器可讀輸出；它不認識 StoreWeave 的任何一個 package。見 ADR 0051。

## 工作圖

記錄有哪些 Story 以及誰是誰的前置。這是**意圖**——哪些工作、什麼順序——與**狀態**（做到哪了）
分開的概念：機器可讀的依賴邊集中在工作圖，Story 的 `Dependencies` 欄位維持散文給人讀，
改順序或插隊不必重新核准已核准的 Story。

它存在哪由 Story Driver 的選擇決定：ForgePilot 把它存成 Work Item 的 `depends_on`，
自寫則是 repo 內一份 `specs/graph.toml`。見 ADR 0051。

## Ticket

`docs/tickets/` 下的歷史存檔，編號 01–100。**不再新增**，既有的一張都不轉成 Story。

## 工作包

`docs/base-implementation-plan.md` 裡的 `B00`–`B17`，是本機規劃識別，不是 GitHub Issue。
B17 收尾後不再新增。
