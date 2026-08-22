# 0012. 後台操作者身分：靜態 API token 是 MVP，多人環境需要帳號驗證

- 狀態：accepted
- 日期：2026-08-21（proposed）／2026-08-21（accepted）

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
但這個「MVP」先前沒有任何紀錄說明它何時該被換掉。這篇先以 proposed 記下那個未決狀態，
四個邊界問題定案後改為 accepted。

## 決策

平台對操作者身分的抽象只有 `Actor`（`id` / `type` / `displayName` / `permissions`）。
Command Bus 與 Query Bus 只認這個型別，`apps/api/src/http/auth.ts` 是唯一把 HTTP 請求
變成 Actor 的地方，因此導入帳號機制是替換一個 adapter 加上一個身分模組，Commerce Core 不受影響。
四個邊界問題的決定如下：

1. **自管帳號密碼**，不強制 OIDC。StoreWeave 的客戶是單站小店，大多沒有 IdP；
   要求 IdP 等於把一部分客戶擋在後台之外。
2. **角色維持常數 `BUILT_IN_ROLES`**，帳號指向既有的 admin / staff / readonly。
   權限模型不進資料庫，因此不需要授權快取與角色管理介面。有具體客戶需求再說。
3. **session 用 httpOnly cookie**（`commerce_session`，SameSite=Strict，12 小時），
   搭配 double-submit CSRF token（`commerce_csrf`，非 httpOnly）。
   https 部署上這兩個名字都會多一個 `__Host-` 前綴，理由見 ADR 0023。
   後台是同源 SPA，短期 JWT 在這裡只換來撤銷困難。
4. **M2M token 維持現狀**。MCP 與 ERP 用的靜態 bearer token 不是人在用，
   繼續走 `auth.tokens` 那條路徑，且不套用 CSRF 檢查——它們不是瀏覽器發的。

三個附帶決定：

- **密碼雜湊用 `node:crypto` 的 scrypt，不用 argon2。** argon2 是原生模組，
  會讓 native release 每個架構都得預先編譯，與「目標主機不需要編譯工具鏈」的
  部署前提衝突（ADR 0007）。scrypt 是記憶體困難雜湊，對這個威脅模型足夠。
- **認證本身不是 Command。** 它發生在 Actor 存在之前，沒有權限可以檢查，
  因此 `AuthService` 由 Interface Adapter 直接呼叫；帳號管理（建立、列出）仍走 Command / Query Bus。
- **CSRF token 由 session token 推導，不是獨立隨機值。** 獨立隨機值的雙提交只要求
  「header 等於 cookie」，能對父網域寫 cookie 的攻擊者可以同時決定兩邊而繞過。
  推導之後他必須先知道受害者的 session token，而那是 httpOnly 的。

## 後果

- audit log 的 actor 從 `token:admin-console` 變成 `user:<uuid>`，內稽核終於問得出「誰改的」。
- 靜態 admin token 仍然有效，兩條路徑並存。這不是過渡期的權宜：
  人用帳號、機器用 token，本來就是兩種不同的東西。
- 登入端點兩層節流：IP + email 10 次 / 分鐘擋針對特定帳號的爆破，
  純 IP 60 次 / 分鐘擋「每次換一個隨機 email 就換一個桶」的 scrypt 放大攻擊。
  節流條件比對的是正規化後的路由而不是原始 URL——`/api/v1/auth/%6cogin`
  會被解碼後打到同一個 handler，用 `request.url.startsWith()` 寫的條件看不出來。
  計數存在行程記憶體：
  單站部署只有一個 API 行程，這與「Redis 是選配」的前提一致（ADR 0003）。
  沒有它，scrypt 會反過來變成放大攻擊面——每次未授權嘗試都逼伺服器做一次記憶體困難運算。
- 未實作的部分要誠實記著：密碼重設、帳號停用介面、二階段驗證、
  改密碼時撤銷既有 session、過期 session 清理、登入失敗鎖定（節流不等於鎖定）都還沒有。
  另外 `createUser` 允許指定 `admin` 角色，唯一的保護是只有 admin 持有 `users:write`；
  日後若把 `users:write` 給了較低角色，那會立刻變成提權路徑。
  這些不影響本決策成立，但在對外宣稱「有完整帳號驗證」之前必須補上。
- 正式部署仍要把 `COMMERCE_ADMIN_TOKEN` 換成隨機值——它現在等於一把不會過期的萬能鑰匙。

## Falsified if

`packages/platform/authorization/src/roles.ts` 的 `BUILT_IN_ROLES` 不再是常數（決定 2 被推翻），
或 `packages/platform/identity/src/password.ts` 不再使用 `node:crypto` 的 scrypt（附帶決定被推翻），
或 `packages/platform/identity/src/auth-service.ts` 的 `authenticate` 被改成註冊在 Command Bus 上的
handler（認證不是 Command 這條被推翻），
或 `apps/api/src/server.ts` 的登入節流條件改回比對 `request.url`（編碼繞過會再度打開）。

## 未閉合、已知的殘留

- 調高 `packages/platform/identity/src/password.ts` 的 `COST` 之後，舊雜湊的使用者會比
  用新參數的 `DUMMY_HASH` 明顯快，等於出現新的帳號枚舉訊號。調參數時必須同時做
  「登入成功後偵測舊參數並 rehash」，讓母體收斂到同一組成本。
- CSRF token 在整個 session 期間固定，一旦連同 header 被第三方工具側錄，12 小時內都可用。
- `logout` 是公開端點因此不受 CSRF 檢查。SameSite=Strict 讓跨站請求根本不帶 session cookie，
  所以實際影響接近零，但這是刻意放寬的一層。
- `http.trustProxy` 目前預設 false，`request.ip` 可信。日後若開啟而反向代理沒有清掉
  `X-Forwarded-For`，來源 IP 可偽造，兩層節流會同時失效。
- 節流條件裡的路由常數（`apps/api/src/server.ts` 的 `LOGIN_ROUTE`）與實際路由字串
  （`@Controller('api/v1/auth')` + `@Post('login')`）分處兩地，型別上不相依。
  日後改動控制器路徑或加上 global prefix，節流會**靜默地失效**而不是報錯。
  目前唯一的守護是整合測試裡那條 429 斷言。
- `/health/dependencies` 只要求「已通過驗證」，沒有再要求任何 permission，
  因此 readonly 與 mcp 角色的 token 也讀得到 provider / extension 的例外訊息與 worker id。
  以維運視圖來說可接受，但這是一個刻意的鬆綁。
- scrypt 的成本白名單雖然收緊到 `N<=65536, r<=8, p=1`，合法範圍的上緣仍比實際使用的
  參數重數倍。另一個方向的副作用是：把 `COST.N` **調低**到 16384 以下會讓既有雜湊
  全部落在範圍外而被判定為密碼錯誤——降低成本是破壞性變更，只有調高是安全的。
- 密碼只有 12 字元下限，沒有上限、也沒有弱密碼字典檢查；session 沒有單一使用者的併發數上限。
