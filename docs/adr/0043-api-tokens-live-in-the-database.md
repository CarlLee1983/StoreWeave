# 0043. 機器對機器的 token 存在資料庫，由 CLI 簽發

- 狀態：accepted；B08 片3 實作，整合與單元回歸通過。
- 日期：2026-09-09

`auth.tokens` 從設定 schema 移除。API token 改存 `platform_api_tokens`，由
`storeweave token:create` 簽發、`token:revoke` 撤銷，格式 `swt1.<id>.<secret>`，
資料庫只留 `sha256(secret)`。每一把都有 `expires_at`，而且不可為 NULL。

設定檔驅動的舊做法有三個性質是同一件事的三面：token 值等於一個環境變數，
所以它沒有到期、不能個別撤銷、也沒有「上次使用時間」。實務結果是
`COMMERCE_ADMIN_TOKEN` 變成一把改不掉的萬能鑰匙——撤銷它要改部署並重啟，
而沒有人知道還有誰在用它，所以沒有人敢動。輪替因此從來不會發生。

改存資料庫之後，撤銷是一次 UPDATE，下一個請求就不通過；`last_used_at` 讓
「這把還有人在用嗎」有答案。代價是每個 bearer 請求多一次索引查詢。沒有加快取：
快取的存活時間就是撤銷的延遲時間，而撤銷要快是這個決策的全部理由。

名字的唯一性只加在還活著的列上（`platform_api_tokens_live_name_idx`）。撤銷過的
`mcp` 要能再發一把 `mcp`，否則輪替就得同時改掉每一份部署設定裡的名字，而那正是
這個決策想解決的「輪替不會發生」。撤銷的列留著，因為它是 `last_used_at` 的歷史。

沒有保留設定檔作為 bootstrap 路徑。第一把 token 由 CLI 在機器上簽發，
與第一個管理員帳號同一條路徑（`user:create`），不需要一個「先有 token 才能建 token」
的雞蛋問題。保留兩套會讓「這個 token 從哪裡來、怎麼撤銷」永遠有兩個答案。

失去的東西要說清楚：舊做法在 `createRuntime` 啟動時就會拒絕「release 不允許的角色」，
現在這個檢查移到簽發當下（`ApiTokenService.issue` 拒絕 `tokenAllowed: false` 的角色），
而已簽發的 token 在角色從 release 消失後由 `resolve()` 擋下。啟動期的整批檢查換成
簽發期與使用期的兩道檢查，不再有「設定檔一眼看完所有 token」這件事——
那份清單改看 `token:list`。

升級路徑：既有部署的 `auth.tokens` 會被設定 schema 拒絕（未知欄位），
升級時必須先 `token:create` 換發，再把設定裡的區塊刪掉。這是刻意的硬失敗：
安靜忽略舊欄位等於讓一批以為還有效的 token 在下一次部署後全部失效。

## Falsified if

`packages/platform/config/src/schema.ts` 重新出現 `auth.tokens`，或
`apps/api/src/http/auth.ts` 不再以 `runtime.apiTokens.resolve` 驗證 bearer（改回比對設定值），
或 `packages/platform/identity/src/migrations.ts` 讓 `platform_api_tokens.expires_at` 可為 NULL，
或 `packages/platform/identity/src/api-tokens.ts` 的 `resolve()` 加上跨請求快取，
或 `platform_api_tokens.name` 改回無條件唯一（撤銷過的名字從此發不出來，輪替被迫改名）；
任一成立表示 token 又變回不能即時撤銷或不會過期的長效秘密，須重開本決策。
