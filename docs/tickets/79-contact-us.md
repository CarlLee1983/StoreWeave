# 79 — 聯絡我們：前台表單與後台收件匣

**What to build:** 顧客沒有地方問一句話。前台加 `GET /contact` 與 `POST /contact`
（SSR 標準表單，沿用既有的 Origin 檢查與 CSRF，ADR 0018），後台加
`apps/admin/src/pages/ContactInboxPage.tsx`：清單、列展開成詳情卡片（照 `CustomersPage`）、
標記已處理。Theme 端是 `renderContact`。

**Blocked by:** 76, 77

**Status:** completed

- [x] 匿名訪客送得出訊息；登入顧客的訊息連到他的顧客身分
- [x] honeypot 隱藏欄位與同一位址的視窗節流，命中時回一般成功畫面——讓機器人分不出差別，
      比擋下來更有用
- [x] honeypot 必須真的離開視線。`.contact-hp` 一度完全沒有樣式，generic 的
      `label { display: grid }` 照樣把它排出來，每位顧客都會看到一個標著「請不要填寫」的欄位；
      手滑或密碼管理器自動填入的真人送出後拿到成功頁而訊息沒有落表
- [x] 節流在**落表之後**才計數。原本在送出前計，填錯三次 email 的顧客第四次會拿到假成功；
      上限同時從 3 放寬到 10
- [x] 表單 body 的形狀也是不可信輸入：重複欄位會變成陣列、JSON 送物件，
      直接 `.trim()` 是 500
- [x] 已處理是不可逆狀態，重複標記回 409；後台的錯誤橫幅放在清單層級，
      收合的列上按下去失敗時也看得到
- [x] `tests/integration/storefront-content.test.ts` 覆蓋匿名送出、honeypot 不落表、
      缺 Origin 被擋，以及登入顧客走完整 HTTP 流程（先取 CSRF 再送出）後 `customerId` 不為 null

## 這一輪不寄信

`packages/commerce/notification` 是訂單綁定的：`queueLifecycleDelivery` 必填 `orderId`，
收件人由 `recipientForNotification` 從訂單查出，沒有「寄一封任意信到 `supportEmail`」的路徑。
要接上它得先改它的收件人模型，那是 notification 自己的邊界，不該由這一輪順手改。
訊息落表後發 `commerce.content.contact.submitted.v1`，收件靠後台收件匣；
日後補一個訂閱者即可，不必回頭改 content。

## 不做的事

- 後台回覆功能——這輪只到「收得到、標記得了」。
