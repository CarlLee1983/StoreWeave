# 0022. 結帳的冪等鍵由伺服器從購物車識別碼導出

- 狀態：accepted
- 日期：2026-08-22

## 背景

平台的其他寫入端點都讀客戶端送來的 `Idempotency-Key` header
（`idempotencyKeyOf(req)`），由呼叫端負責在重試時帶同一把。

結帳不能這樣做。Spec 0003 點名的缺陷正是「`POST /checkout` 的 key 是每次現產的
隨機值」——瀏覽器重送表單、使用者連點兩下、網路逾時重試，這三種情況下客戶端
都不會、也沒有辦法帶同一把鍵。要求它帶對，等於把保護的責任交給最不可能做對的一方。

## 決策

結帳的冪等鍵由伺服器導出：`cart:{actorId}:{cartId}`，客戶端送的
`Idempotency-Key` 在這兩支端點上**被忽略**。

- 購物車識別碼是那把鍵天然的來源：同一台車的結帳就是同一次結帳。
- 前面補上 actor：冪等鍵決定了誰讀得到快取的回應，而購物車識別碼是猜得到的。
  Command Bus 另外會比對宣告者的身分（ADR 見 `command-bus.ts` 的註解），兩層都要。
- `cartId` 由畫面帶回來而不是「現在的車」：結完帳那台車就關了，重送的請求若改問
  現在的車會問到一台新的空車。

真正的保證不只在鍵上——`checkoutCart` 會鎖住購物車那一列並檢查它有沒有結過
（`cart_carts.order_id`）。冪等鍵擋的是併發，那把鎖擋的是重放。

## 考慮過的選項

- **照既有慣例讀 header。** 否決：那正是要修的缺陷。
- **只靠 `cart.orderId` 而不設鍵。** 否決：併發的兩筆請求都會進到 handler，
  第二筆會卡在行鎖上等第一筆 commit——正確但比較貴，而且會多做一次定價。
- **讀 header，缺席時才用導出的值。** 否決：那讓同一台車可能有兩把鍵，
  於是「同一台車只會有一張訂單」不再成立。

## 後果

- 送 `Idempotency-Key` 給 `POST /api/v1/cart/checkout` 或 `POST /checkout` 不會有效果。
  這是公開 API 契約的偏離，因此記在這裡——後來的讀者不知情的話會去「修好」它。
- 同一台車從 REST 與前台各結一次會得到同一張訂單（鍵相同、輸入相同）。
- 其他端點不受影響，維持讀 header 的慣例。

## Falsified if

`apps/api/src/controllers/cart.controller.ts` 或
`apps/api/src/storefront/storefront.controller.ts` 的結帳改成讀
`idempotencyKeyOf(req)`，或 `packages/commerce/order/src/commands.ts` 的
`createCheckoutCartHandler` 不再檢查 `cart.orderId` —— 任一項成立，
代表結帳的冪等換了來源，這篇記的理由要重新檢視。
