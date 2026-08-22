# 50 — 舊模組的 Command / Query 輸入一律拒絕未知欄位

**What to build:** Command Bus 與 Query Bus 上還沒有 `.strict()` 的輸入全部補上，未知欄位一律回 `VALIDATION_ERROR`，與 cart、coupon 以及後來新增的 input 保持同一個答案。範圍是 catalog、inventory、customer、order、promotion 五個 commerce 模組的 20 個具名 input，四支內嵌在註冊處的匿名 `z.object()`，平台的 identity 與 jobs，以及巢狀的輸入物件。Extension 的三支不在範圍內，理由見 ADR 0024。

**Blocked by:** —

**Status:** done

- [x] 六個模組的 input schema 全部 `.strict()`，包含四支內嵌在註冊處的匿名 `z.object()`
- [x] 每一支註冊中的輸入都有一條測試真的解析一次並斷言被擋（不是讀 `_def.unknownKeys`）
- [x] 內部呼叫端逐一追過：`scripts/smoke.sh` 的下單請求是壞的（帶著工單 21 移除的 `customerEmail`，且用服務 token 下單），已修並實跑 `smoke:docker` 驗證
- [x] MCP 沒有 `mapInput` 的工具不會把 `idempotencyKey` 送進下游的 strict schema
- [x] 契約變更記在 ADR 0024，並在 `docs/operations.md` 說明升級時可能看到的 400
- [x] 400 的回應帶得出是哪一個欄位（`VALIDATION_ERROR` 的 `details`），否則只是把沉默換一種形式

## 為什麼是一張獨立的票

這會改變既有客戶端的行為：今天送了多餘欄位而被安靜忽略的請求，之後會拿到 400。
`createPromotionInput` 在工單 10 就已經是 `.strict()`，因此「同一個問題有兩個答案」
這件事本身也是這張票要收掉的——同一批 API 裡有些端點挑剔、有些不挑剔，比兩者都寬鬆更糟。

`addressDto` 與 `promotionRule` 這兩支同時是讀回來時走的 schema，因此只收緊寫入側
（`addressInput`、`promotionRuleInput`）：一起收緊會把舊資料裡多存的鍵變成「這筆從此讀不回來」。
