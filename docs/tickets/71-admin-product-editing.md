# 71 — 後台商品編輯與上下架

**What to build:** 商品目前建得出來、改不了。`PATCH /api/v1/products/:id`
（`commerce.catalog.updateProduct`）與 client 端的 `api.patchProduct` 都在，`ProductsPage`
卻只有建立、庫存調整與搜尋——名稱、描述、售價與 `draft / active / archived` 三態在後台
都沒有入口。補上編輯，讓目錄狀態機在 UI 上走得動。

**Blocked by:** —

- [ ] 商品列可展開或開啟編輯表單，帶入現值；未修改的欄位不送出
- [ ] 售價維持 cents 整數驗證，與建立表單同一套規則，不另寫一份
- [ ] 上下架是明確的狀態轉換，不是自由下拉：draft→active→archived 各自有按鈕與確認
- [ ] 已下架商品不影響既有訂單的價格快照——UI 要講清楚這件事，避免誤以為改價會回溯
- [ ] 以 jsdom 測試覆蓋帶入現值、部分欄位更新與狀態轉換

## 不做的事

- 商品變體、多圖、SEO 欄位與批次編輯；售價改動的歷史軌跡（稽核已由 command 記下）。
