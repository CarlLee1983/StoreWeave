# 0004. MCP 只是一種 Interface Adapter

- 狀態：accepted
- 日期：2026-08-21

## 背景

AI 客戶端需要操作商店。最快的作法是給 MCP server 一個資料庫連線，讓它直接查表——
也是最糟的作法：權限、驗證、Idempotency、Audit 全部會被繞過，而且 Core 的資料表變更會直接打斷 MCP。

## 決策

MCP 與 REST、Admin、CLI 完全平行，都是 Interface Adapter，唯一的能力是把請求轉發到
Command Bus 或 Query Bus。

這件事**用型別強制**，不是靠紀律：`McpToolDefinition`（`packages/platform/extension-sdk/src/mcp.ts`）
的 `target` 只能是 `{ kind: 'command' | 'query'; name: string }`。工具無法表達
「執行一段 SQL」或「呼叫某個 repository」——那不是被禁止，而是**寫不出來**。

- 協定轉接（JSON-RPC 2.0）住在 `apps/api/src/mcp/mcp.controller.ts`。
- 工具目錄由 Extension 宣告（`packages/extensions/mcp`），Core 完全不認識 MCP。
- 工具以**呼叫端的 actor** 執行，不是以 Extension 的身分；MCP token 的角色決定它能做什麼。
- 指向 Command 的工具必須宣告 `requiresIdempotencyKey`，且呼叫時必須提供。

## 後果

- MCP 自動獲得與 REST 相同的授權、驗證、Idempotency 與 Audit，不需要第二套。
- 新增 MCP 工具不需要改 Core，只要 Command/Query 已經存在。
- 代價：MCP 無法做「Bus 上沒有的事」。這正是我們要的——需要新能力就先加 Command 或 Query。

## Falsified if

`packages/extensions/mcp/src/tools.ts` 出現無法以既有 Command / Query 表達的工具需求，
或 `apps/api/src/mcp/mcp.controller.ts` 需要為了效能而直接讀取資料庫；
`tests/architecture/boundaries.test.ts` 的「MCP 不得繞過 Application Layer」會先失敗。
