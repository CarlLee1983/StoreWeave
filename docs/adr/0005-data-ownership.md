# 0005. Extension 資料與 Core 資料的所有權規則

- 狀態：accepted
- 日期：2026-08-21

## 背景

「Extension 不得直接更新其他模組的資料表」如果只是文件上的規定，第一次趕工就會被打破。
它必須是**拿不到**，而不是**不應該**。

## 決策

資料所有權有三條規則，全部由型別與執行期共同執行：

1. **Core 資料只有 Core 能寫。**
   Extension 的 handler 收到的是 `ExtensionContext`（`packages/platform/extension-sdk/src/context.ts`），
   裡面沒有 `tx`、沒有 `db`、沒有連線池。要改 Core 資料只能呼叫 Command，
   而 Command 會用 Extension 的 actor 檢查權限——manifest 沒宣告的權限一律 FORBIDDEN。

2. **Extension 資料只有自己能讀寫。**
   `ExtensionStore` 由 `DbExtensionStore` 實作，每一句 SQL 都以 `extension_id` 過濾，
   而那個 id 是掛載時綁定的，Extension 無法改變。Extension A 讀不到 Extension B 的資料。

3. **命名空間是契約的一部分。**
   Extension 註冊的 Command / Query / Job 一律必須是 `ext.<id>.*`，
   而且 manifest 宣告的清單必須與 `setup()` 實際註冊的完全一致，否則掛載直接失敗。

Core 模組之間也不直接跨表：`order` 扣庫存是呼叫 `inventoryService.adjust`，
不是自己 `UPDATE inventory_stock`。

## 後果

- Core 的資料表 schema 是內部實作，可以自由重構，只要 DTO 與 Command/Query 契約不變。
- Extension 的資料不會被 Core 的 migration 動到，也不需要自己的 migration。
- 代價：Extension 的複雜查詢只能靠 `ExtensionStore` 的 key/prefix 掃描；
  真的需要關聯查詢時，正確作法是請 Core 新增一個 Query，而不是給 Extension 資料庫連線。
- 代價：Extension 寫入自己的儲存與 Core 的交易不在同一個交易內。這是刻意的——
  Extension 出錯絕對不能讓核心訂單交易處於不一致狀態，代價是 Extension 必須自己冪等。

## Falsified if

`packages/platform/extension-sdk/src/context.ts` 出現任何形式的資料庫控制代碼，
或 `packages/platform/kernel/src/extension-store.ts` 的查詢不再以 `extension_id` 過濾，
或 `packages/platform/kernel/src/extension-host.ts` 的命名空間檢查被放寬。
