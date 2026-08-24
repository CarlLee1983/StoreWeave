# 0029. 物流獨立成模組，付款留在 order

- 狀態：accepted
- 日期：2026-08-24

## 背景

金物流這一批要新增兩類持久化資料：運送方式（店家維護的費率與門檻）與出貨紀錄
（狀態機、外部識別碼、回呼歷程）。Extension 沒有 migration、拿不到 `tx` 或 `db`
（ADR 0002、`packages/platform/extension-sdk/src/registration.ts`），
所以這些表一定屬於某個 core module。

付款那一側則是擴充既有的 `order_payments`：每一列從「一筆成功的收款」變成
「一次收款嘗試」，加上 pending 與 failed。

看起來對稱的兩件事，該不該住在對稱的位置。

## 決策

新開 `packages/commerce/shipping`，擁有運送方式與出貨。付款留在 `packages/commerce/order`。

**這個不對稱是刻意的。**

## 考慮過的選項

- **全部放進 `order`。** 否決：運送方式是店家維護的商業資料，有自己的後台頁、
  自己的權限、自己的 provider 與三條回呼。塞進 `order` 會讓那個模組同時服務
  訂單、付款、物流三個狀態機，而它已經是 commerce 裡最大的一個。
- **把付款也抽成 `payment` 模組，三者對稱。** 否決，而這是最誘人的選項。
  `markPaid`（`packages/commerce/order/src/commands.ts`）不是一個付款動作——
  它同時做庫存 commit、購物金累積、等級積分累積、發 `commerce.order.paid.v2`，
  抽出去要跨模組拉四五個 service，而跨模組只能走對方匯出的 service
  （見「模組邊界」與 ADR 0005）。付出那個代價換到的只有「看起來整齊」：
  付款沒有任何店家維護的資料、沒有後台頁、沒有自己的 aggregate。

## 後果

- 原本規劃的 `order_shipments` 因此改名為 `shipping_shipments`，
  而它指向 Order 就成了**跨模組參照**——依 ADR 0021 不加外鍵，
  完整性由服務層負責。這是把物流搬出 `order` 要付的具體代價。
- `order` 仍然是付款狀態的擁有者，`shipping` 透過匯出的 service 呼叫它——
  代收貨款的取貨回報要造成 `markPaid`，那個呼叫的方向是 shipping → order，
  不是反過來。
- **後來的人會想「修正」這個不對稱。** 這篇存在的主要理由就是攔下那次修正：
  對稱本身不是價值，`markPaid` 的耦合才是事實。真要抽 `payment`，
  先處理的是那個 handler 的四件事，不是模組的位置。

## Falsified if

`packages/commerce/order/src/commands.ts` 的 `markPaid` 不再直接負責庫存 commit
與購物金／等級積分累積（改為由訂閱事件的模組各自處理），
或 `packages/commerce/shipping/` 開始擁有付款相關的表。

前者成立代表抽出 `payment` 的主要成本消失了，這個不對稱就沒有理由繼續；
後者成立代表邊界已經漂掉，這篇記的分工要重新檢視。
