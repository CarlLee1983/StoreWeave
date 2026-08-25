# 0032. 商品狀態的合法轉換只在後台具名，command 不強制

- 狀態：accepted
- 日期：2026-08-25

## 背景

`commerce.catalog.updateProduct` 收下任何 `draft / active / archived` 之間的轉換：
`packages/commerce/catalog/src/commands.ts` 只檢查 patch 非空，沒有狀態機。工單 71 補上
後台編輯時，需要決定「上下架」在 UI 上長什麼樣，於是這件事第一次被迫講清楚。

做法是在 `apps/admin/src/pages/ProductsPage.tsx` 放一張具名的轉換表：draft 給「上架」，
active 給「下架回草稿」與「封存」，archived 給「重新上架」。**這張表不是不變式，是動線**——
它讓店員看見「收回去改」與「這個商品退役了」是兩件不同的事，而不是在一個自由下拉裡自己想。

## 決定

商品狀態的合法轉換不在 command 端強制。真正要守住的不變式是**只有 active 的商品買得到**，
它由 `packages/commerce/catalog/src/service.ts` 的 `requireActiveProduct` 在結帳路徑上擋，
與商品怎麼走到那個狀態無關。

理由是這兩件事的失敗代價不同。買到一個不該賣的商品會產生一張錯的訂單，必須擋；
而把 archived 直接改回 active、或跳過 draft 直接上架，都只是營運動線上的選擇——
資料匯入、批次上架、修正一次誤操作，全都是正當理由，寫死轉換只會讓它們要繞路。

## 被否決的選項

- **在 command 端加狀態機。** 否決：它會擋掉匯入與批次修正這些正當路徑，而換來的保護
  （不會跳過 draft）沒有對應的實質風險——沒有任何不變式依賴「商品曾經是 draft」。
- **在 UI 也放自由下拉，與 command 一致。** 否決：一致不是目的。下拉會讓「下架回草稿」
  與「封存」看起來是同一種操作，而它們對商品的意義完全不同。

## Falsified if

`packages/commerce/catalog/src/commands.ts` 的 `updateProductHandler` 長出任何依前一個
狀態決定能不能改的檢查，或 `packages/commerce/catalog/src/service.ts` 的
`requireActiveProduct` 不再以 `status !== 'active'` 作為可購買與否的判準。

前者代表轉換被認定為必須守住的不變式，後者代表可購買性改由別的東西決定——
兩者任一成立，這篇把「不變式在結帳、動線在 UI」分開的理由就要重新檢視。
