# 0010. 平台對領域中立，Commerce 是產品不是 kernel

- 狀態：accepted
- 日期：2026-08-21

## 背景

第一個產品是商店，但 kernel 只組裝 Command / Query / Event / Job / Permission / Extension / Theme。
若文件與註解把 `packages/platform` 叫成 Commerce Core，後續模組會被誤以為必須是購物領域，
也會誘使把商店假設寫進 Bus 與 Runtime。

## 決策

- `packages/platform`（`bundle` 除外）不得依賴 catalog / inventory / order 的型別或資料表。
- 產品由 Bundle 組裝：`packages/platform/bundle` 是 Commerce Release，不是 kernel。
  換產品 = 換那份模組清單。
- Command / Event 名稱空間由模組自己宣告。kernel 只檢查格式；
  事件為 `<context>.<aggregate>.<action>.vN`，Extension 為 `ext.<id>.*`。
  不要求 `commerce.` 前綴。
- 不重命名 `commerce.order.placeOrder` 等已公開契約，那些屬於 commerce 模組。
- 第一版不重命名 `commerce.yaml`、`CommerceConfig`、CLI、Admin、Theme。
  那些是商店產品的介面，通用殼另案處理。

## 後果

- 可以另寫模組掛上同一 Runtime，不必 fork kernel。
- 既有商店部署的設定檔、CLI、command 名稱維持不變。
- Admin / Storefront Theme 仍假設商店；這不是本決策的範圍。

## Falsified if

`packages/platform/kernel` 或 `packages/platform/command-bus` import `@storeweave/catalog`、
`@storeweave/inventory` 或 `@storeweave/order`，或 `packages/platform/contracts/src/events.ts`
的 `EVENT_NAME_PATTERN` 開始要求 `commerce.` 前綴。
