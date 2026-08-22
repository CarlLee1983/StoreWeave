# 50 — 舊模組的 Command / Query 輸入一律拒絕未知欄位

**What to build:** catalog、inventory、customer、order、promotion、loyalty 六個模組裡還沒有 `.strict()` 的 20 個 input schema 補上，未知欄位一律回 `VALIDATION_ERROR`，與 cart、coupon 以及後來新增的 input 保持同一個答案。

**Blocked by:** —

**Status:** done

- [x] 六個模組的 input schema 全部 `.strict()`，`packages/**/dto.ts` 裡不再有寬鬆的 input
- [x] 每個模組至少一條測試斷言「多帶一個不認得的欄位會被擋下來」
- [x] 內部呼叫端（controller、storefront、job、MCP、demo-erp）沒有任何一處在送多餘欄位
- [x] 契約變更記在 ADR 0024，並在 `docs/operations.md` 說明升級時可能看到的 400

## 為什麼是一張獨立的票

這會改變既有客戶端的行為：今天送了多餘欄位而被安靜忽略的請求，之後會拿到 400。
`createPromotionInput` 在工單 10 就已經是 `.strict()`，因此「同一個問題有兩個答案」
這件事本身也是這張票要收掉的——同一批 API 裡有些端點挑剔、有些不挑剔，比兩者都寬鬆更糟。
