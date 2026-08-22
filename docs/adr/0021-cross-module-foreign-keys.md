# 0021. 跨模組的參照不加外鍵，模組內的加

- 狀態：accepted
- 日期：2026-08-22

## 背景

程式碼裡目前有兩個跨模組的參照，答案相反：

- `customer_customers.account_id` → `platform_users(id)`，**有**外鍵與 `ON DELETE CASCADE`。
- `order_orders.customer_id` → `customer_customers(id)`，**沒有**外鍵。

兩者都是「A 模組的資料表指向 B 模組的資料表」，卻做了不同的選擇，而且都沒有寫下理由。
工單 40 之後又多了三個同類的參照（`loyalty_reward_entries.customer_id`、
`loyalty_tier_entries.customer_id`、`coupon_coupons.customer_id`），
不決定的話它們也會各憑感覺。

## 決策

**模組內的參照加外鍵，跨模組的參照不加**，只有一個例外：
`customer_customers.account_id` 保持現狀。

理由是模組邊界的意義：ADR 0005 已經規定模組之間只透過彼此匯出的 service 互動、
不直接讀寫對方的資料表。外鍵是資料庫層的直接耦合——它讓 migration 有了順序相依、
讓「把某個模組換掉」變成資料庫層的問題，而不只是程式碼的問題。

`account_id` 的例外有實質理由：顧客與帳號是**同生共死**的一對
（`registerCustomer` 在同一個交易裡建立兩者），刪掉帳號而留下顧客資料
不是一個有意義的狀態。其他的參照不是這樣：訂單、券、購物金分錄
在顧客被停用甚至刪除之後仍然要留著——那是帳，不是附屬品。

## 考慮過的選項

- **全部加外鍵。** 否決：等於在資料庫層固定住模組的組裝順序，
  與 ADR 0010（平台對領域中立、模組是可換的組合）相衝。
- **全部拿掉，包含 `account_id`。** 否決：那個 CASCADE 目前在做真正的事——
  刪帳號會把顧客資料一起帶走。拿掉它要另外寫一段清理程式碼，
  而那段程式碼只會在極少的路徑上被執行，因此也最容易壞掉。
- **用觸發器或應用層檢查取代。** 否決：成本高、可觀察性差，
  而目前沒有任何一個已知的資料完整性問題需要它。

## 後果

- 跨模組的孤兒列在理論上是可能的（顧客被硬刪、訂單留著）。
  實務上顧客只會被**停用**（`setCustomerStatus`），沒有刪除的路徑。
  真的需要刪除時，那是一個要明確設計的動作，不是外鍵的副作用。
- 模組的 migration 之間沒有順序相依，只有 `coupon → promotion`
  這一個模組內的例外（券指向活動，兩者同屬行銷）。
- 新的跨模組參照一律照這條規則，不必每次重新討論。

## Falsified if

`packages/commerce/order/src/migrations.ts`、`packages/commerce/loyalty/src/migrations.ts`
或 `packages/commerce/coupon/src/migrations.ts` 出現指向 `customer_customers` 的
`REFERENCES`，或 `packages/commerce/customer/src/migrations.ts` 的 `account_id`
不再有外鍵 —— 任一項成立，代表這條規則已經被換掉，這篇記的理由要重新檢視。
