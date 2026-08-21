# 0014. 顧客身分：認證共用平台，顧客資料歸 Commerce

- 狀態：accepted
- 日期：2026-08-22

## 背景

購物金要累在誰身上、優惠券要限定誰能用、生日禮券要發給誰 —— 這些都需要一個「顧客」主體，
而目前不存在。`CONTEXT.md` 沒有 Customer 這個詞，`order_orders.customer_email` 是一個
未經驗證的自由文字欄位，`ctx.actor` 與訂單之間沒有任何持久化關聯。

ADR 0012 解決的是**後台操作者**身分。它的底層結構（`platform_users` + `platform_sessions` +
role 字串）其實是泛用的，卡住的不在 identity 模組，而在三處：

1. `packages/platform/contracts/src/actor.ts` 的 `type` 是封閉聯集 `'user' | 'service' | 'extension' | 'system'`。
2. 授權模型只有 permission 字串比對與 `xxx:*` wildcard，**沒有 resource ownership**，
   「顧客只能看自己的訂單」在這個模型裡表達不出來。
3. `apps/api/src/http/auth.ts` 的 `@Public()` 分支**無條件覆寫** `request.actor` 成固定的匿名
   storefront actor，完全不看 cookie；而 `StorefrontController` 整個 class 掛著 `@Public()`。
   前台因此在結構上不可能辨識登入者。

順帶發現一個既存缺口：`storefront` 角色持有無範圍限制的 `order:read`，而 `GET /orders/:number`
只用訂單號查、不驗身分 —— 任何人猜到訂單號就能讀別人的訂單。它需要的正是第 2 點缺的東西。

## 決策

**認證機制共用平台，顧客資料歸 Commerce。** `packages/platform/identity` 繼續是唯一一套
密碼雜湊、session 與 CSRF 的實作，它只知道「這是一個帳號」，不知道帳號背後是顧客還是店員。
顧客的領域資料 —— 生日、會員等級、等級積分、購物金、收件地址 —— 屬於
`packages/commerce/customer`，兩者以 `Actor.id` 相連。

理由：ADR 0010 要求平台對領域中立。「有帳號的人」不是領域概念，「會下單的顧客」是。
把顧客資料放進平台會讓 0010 破功；為前台另寫一套密碼雜湊與 session 則是自找漏洞。

**`Actor.type` 新增 `'customer'` 成員。** 不擠進 `'user'`。代價是所有型別窄化處要跟著改，
換得的是 Audit Log 的 `actor_type` 永久分得出「店員改了訂單」與「顧客改了訂單」——
擠進 `'user'` 會讓這個區分再也拿不回來。

**Resource ownership 在 query handler 層以 `ctx.actor` 過濾，不進授權層。**
授權層維持「只比對 permission 字串」的簡單模型；「只能看自己的」由知道領域語意的 handler 負責。
這同時就修掉了上述的訂單越權讀取。

**`@Public()` 的語意從「強制匿名」改為「不需要 token」。** 守衛改成三段式：
有 session cookie 就 resolve 成該 Actor，沒有才 fallback 成匿名 storefront actor。

**結帳必須是已登入的 Customer。** 不做訪客結帳。這是一個會影響轉換率的產品取捨，
換得的是每一張訂單都有確定的歸屬 —— 購物金、等級、退款、再行銷都建立在這個前提上。

**前台認證做到密碼重設與改密碼撤銷 session，不做 email 驗證。**
ADR 0012 誠實列出的未實作項，在只有幾個店員的後台可以忍，在前台會員系統不能忍。
Email 驗證則會擋住註冊轉換，而結帳已經強制登入。

## 考慮過的選項

- **顧客用完全獨立的一套認證。** 否決：等於維護兩套密碼雜湊與 session 過期邏輯，
  而 ADR 0012 的那套已經處理了 scrypt 成本參數、CSRF 推導、登入節流這些容易做錯的細節。
- **用 Policy Registry 表達 ownership。** 否決：Policy 只能 `deny`，且看得到什麼 resource 屬性
  取決於呼叫端有沒有傳；把「只能看自己的」寫成一條全域 policy，會讓後台的合法查詢也要處處傳屬性繞開它。
- **替 authorization 加上真正的 ownership 概念。** 否決：那是平台級改造，且與 ADR 0013
  記下的「不因領域需求改造平台」同一個理由。

## 後果

- 寄信成為必要能力（密碼重設、生日禮券、棄單提醒），因此新增第四種 Provider kind `notification`，
  與 payment / shipping / erp 並列。這是本批工作中唯一刻意改動 `packages/platform` 的地方，
  且它與 ADR 0010 相容：通知跟付款一樣是領域中立的。
- `placeOrder` 的 `customerEmail` 自由文字輸入失效，改為由 Actor 決定下單者。這是既有契約變更。
- `@Public()` 語意變更會影響所有掛著它的端點，必須逐一確認沒有端點依賴「一定是匿名」這件事。
- Audit Log 從此有兩種人類 actor type，既有的稽核查詢若假設 `'user'` 等於「後台操作者」會失準。

## Falsified if

`packages/platform/contracts/src/actor.ts` 的 `Actor.type` 不再包含 `'customer'`，
或 `packages/platform/identity` 出現任何 commerce 專屬的顧客欄位（生日、等級、點數），
或 `apps/api/src/http/auth.ts` 的 `@Public()` 分支重新變回無條件覆寫 `request.actor`，
或 `packages/commerce/order/src/queries.ts` 的 `getOrder` 對 `customer` 型別的 actor 不再以 `ctx.actor` 過濾。
