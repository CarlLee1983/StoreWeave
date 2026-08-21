# 0012. 後台操作者身分：靜態 API token 是 MVP，多人環境需要帳號驗證

- 狀態：proposed
- 日期：2026-08-21

## 背景

目前「你是誰」完全由一串靜態 bearer token 決定。`commerce.yaml` 的 `auth.tokens`
把每個 token 綁一個角色，實際值從環境變數讀，`apps/api/src/http/auth.ts` 逐一比對後
把 `permissionsForRole(role)` 掛成這次請求的 Actor。後台沒有登入畫面，
token 由使用者自己貼進去，存在瀏覽器的 localStorage。

單人或單一維運團隊的部署這樣夠用，但多人環境有三個問題：

- **不能歸屬到人**：audit log 只記得到 `token:admin-console`。兩個人共用同一串，
  就查不出是誰改的。這讓 audit log 對內稽核失去意義。
- **不能個別撤銷**：某人離職要換 token，等於所有人一起斷線。
- **沒有到期，且暴露面大**：token 長期有效地躺在 localStorage，一次 XSS 就整串外流。

`packages/platform/authorization/src/roles.ts` 的註解寫著「MVP 的角色→權限映射」，
但這個「MVP」先前沒有任何紀錄說明它何時該被換掉——這篇 ADR 就是要把那個未決狀態存起來。

## 現況（不是決策，是待決事項）

平台對操作者身分的抽象只有 `Actor`（`id` / `type` / `displayName` / `permissions`）。
Command Bus 與 Query Bus 只認這個型別，`apps/api/src/http/auth.ts` 是唯一把 HTTP 請求
變成 Actor 的地方。因此導入帳號機制是替換一個 adapter 加上一個身分模組
（擁有 `platform_users` 之類的資料表），Commerce Core 不受影響。
技術路徑不是這篇的難點，以下四個邊界問題才是：

1. **角色是寫死還是資料**：`BUILT_IN_ROLES` 目前是常數。要不要變成資料庫裡可編輯的，
   直接決定權限模型要不要 migration 與管理介面。
2. **session 形式**：httpOnly cookie 或短期 JWT。前者要處理 CSRF，後者要處理撤銷。
3. **密碼自管還是 OIDC**：自管要面對雜湊、重設、鎖定、二階段驗證；
   走 OIDC 則把這些交給客戶既有的 IdP，但單站小客戶未必有 IdP。
4. **M2M token 的去留**：MCP 與 ERP 用的 token 不是人在用，
   傾向維持靜態形式，與人的帳號分成兩條路徑。

在這四點定案前不動程式碼。決定後，這篇改為 accepted 或由新的 ADR 取代。

## 後果（維持現狀期間）

- 正式部署必須把 `COMMERCE_ADMIN_TOKEN` 換成足夠長的隨機值並限制知悉範圍；
  `commerce doctor` 會擋掉預設值。
- audit log 的 `actor` 欄位在多人共用 token 時不具個人歸屬力，
  引用它做內稽核之前要知道這個限制。
- 不要為了「先有登入」而加一層之後要拆掉的暫時性驗證。
  依 coding-style，stopgap 不是可接受的設計。

## Falsified if

`packages/platform/authorization/src/roles.ts` 的 `BUILT_IN_ROLES` 不再是常數，
或 `apps/api/src/http/auth.ts` 開始從資料庫查詢操作者身分——
兩者任一發生，代表帳號機制已經落地，這篇必須改狀態或被取代。
