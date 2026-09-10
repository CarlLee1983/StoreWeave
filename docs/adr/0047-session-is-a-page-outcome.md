# 0047. Session 是頁面的 outcome，不是頁面的能力

- 狀態：proposed；2026-09-10 定案，實作與整合回歸通過後改 accepted。轉 accepted 之前
  必須先消除下面「Falsified if」第四條現存的違反——`startSession` 目前被三個呼叫端繞過，
  不修掉的話本決策一落地就自我否證。
- 日期：2026-09-10

ADR 0045 把前台頁面從 Theme 挪到模組宣告，但登入／註冊／忘記密碼／重設密碼四頁留在
`apps/api/src/storefront/storefront.controller.ts` 的 decorator 路由裡，`SYSTEM_PAGE_IDS`
因此還有 `platform.auth`。理由寫在 `packages/platform/kernel/src/page.ts` 的註解上：
頁面能碰的 cookie 只有訪客購物車那兩個具名動作，而登入要簽發 session。

直覺的解法是在 `PageResolveContext` 上再開一個具名的 session 入口。但那正好是 ADR 0045
的 falsification 條件守著的介面——它禁止那個 context 長出 runtime、database、logger 或
請求物件，理由是頁面一旦拿得到執行環境就難測、模組對平台的耦合就回到重構前。多開一個
入口不違反字面，卻違反它守的東西。

## 決策

**session 是 `resolve` 的回傳值，不是它的能力。** `PageOutcome` 新增兩個具名 kind——
`session-start`（帶 `IssuedSession` 與轉址目的地）與 `session-clear`——由路由層執行
cookie 寫入、訪客購物車合併與轉址。`PageResolveContext` 一個欄位都不動。

這樣選有三個理由。契約裡早就有 `cookieEffects: ['session-start']` 與 `['session-clear']`
這組詞彙（`apps/api/src/storefront/storefront.contract.ts`），outcome 用同樣的名字，
契約與實作因此同源，而不是靠人維持一致。其次，`PageResolveContext` 的形狀不變，ADR 0045
的條件連重開都不必。第三，訪客購物車合併天生屬於路由層：`apps/api/src/http/session-start.ts`
現在刻意繞過 `cart-cookie.ts` 的包裝直接讀 cookie，因為身分剛出現的那一刻那些包裝會把人
判成已登入而拿不到訪客 token——這種時序細節放進模組頁面只會被複製錯。

被否掉的替代是「泛化成帶 effect 陣列的 outcome」。現在只有兩個 effect，而且都跟 session
有關；先立一個空框架，第一個不是 session 的 effect 出現時多半也不合身。

**這四頁由新的 `platform-auth` 模組宣告，由 release 組裝。** 套件
`packages/platform/auth`（`@storeweave/auth`），工廠 `createAuthModule({ registerCommand })`。
`AuthService` 留在 `platform-identity` 不動；identity 繼續不宣告任何頁面。

沒有讓 identity 直接宣告這些頁面，雖然那樣改動最小。identity 不在任何 release 的模組清單
裡，是 kernel runtime 直接掛進去的（`packages/platform/kernel/src/runtime.ts`）——讓它貢獻
頁面等於「頁面集合由 release 決定」出現一個永久的例外，而 ADR 0046 才剛把導覽與網站設定
判成 release 決定的資料。也沒有併進 `platform-site`：那個模組是導覽與網站設定的擁有者，
加進認證頁會讓兩種變更理由完全不同的東西共用一個模組。

**註冊命令由 release 指定。** commerce release 傳 `commerce.customer.registerCustomer`，
base release 不傳、走 `AuthService.register()`。這是 `createSiteModule({ defaultNavigation })`
的同一個模式，而且 `packages/platform/authorization/src/roles.ts` 早就寫下同樣的判斷：
「Commerce 的顧客不走這裡：它的註冊同時要建立 Customer，因此是 commerce 的 command。」
改成由 identity 註冊、commerce 用事件擴充 Customer 會破壞現有的同交易保證——帳號與顧客
資料目前同生共死。

**base release 也拿到登入頁。** `packages/themes/base/src/index.ts` 已經有 `platform.auth`
的 renderer，ADR 0041 建立的 `member` 角色也帶著 `selfServiceRegistration`；缺的只是路由。
連帶好處是 `apps/api/src/releases/base.ts` 那份不合併購物車的 `startSession` 分支可以移除——
合併與否變成 release 有沒有購物車模組的自然結果，不需要兩份實作。

**theme 的 auth view 拆成四個。** `ThemeAuthView` 現在是一個四模式的 discriminated union，
因為只有一個 renderer。拆成九個 page（四組 GET／POST 加 logout）之後，每個 renderer 都會
收到一個它只處理其中一支的 union，所以型別跟著頁面拆開。theme 的 renderer map 多八個 key，
實際渲染函式仍是四個——`commerce.content.contact` 與 `commerce.content.submitContact` 指向
同一個函式已經是既有先例。`logout` 設 `required: false`（只轉址、沒有畫面）。REST 版的
logout（`apps/api/src/controllers/auth.controller.ts`）原樣保留：它的呼叫端要 JSON，
表單版要 303，合併只會逼出一個判斷 Accept header 的分支。

**`ReleaseHttpAdapter.startSession` 成為唯一入口。** 這個 hook 現在存在但被繞過三次——
前台的登入與註冊表單、`apps/api/src/controllers/customer.controller.ts` 都直接 import
commerce 版的實作。搬遷時全部改回經過 adapter。沒有改成「cart 模組監聽登入事件自己合併」，
因為合併必須發生在簽發 cookie 之後、回應送出之前，改成事件會讓失敗處理與那張一次性的
購物車提示 cookie 都失去時序保證。

## 兩處行為變更

`next` 的清洗從 controller 的私有函式上移到路由層，兌現契約上早就宣告的
`redirect({ kind: 'validated-same-origin' })`。這是開放轉址的防線，留在每個模組自己實作
就是等著哪個模組漏掉。

已登入的人打開 `/login` 改成導向 `next`，不再重新渲染登入表單。現行行為會讓人以為自己
登出了，然後送出表單再簽一次 session。

## 不涵蓋

前台角色目前都不要求第二因素（只有 operator 系的角色是 `mfa: 'required'`），所以登入頁
不處理強制註冊；哪天前台角色要求了，那個判斷屬於頁面而不是路由層。

`member` 登入之後看得到什麼——特別是站內收件匣要不要給它——不在本決策裡。那是授權面的
問題，`roles.ts` 的註解原本指名給 B13，現改為 B14。

## Falsified if

`packages/platform/kernel/src/page.ts` 的 `PageOutcome` 失去 `session-start` 與
`session-clear` 這兩個 kind，或它的 `PageResolveContext` 反過來長出任何 session 入口；
或 `packages/platform/kernel/src/page.ts` 的 `SYSTEM_PAGE_IDS` 重新出現 `platform.auth`；
或 `apps/api/src/storefront/storefront.controller.ts` 重新以 decorator 列出任何 auth 路由；
或 `apps/api/src/release-adapter.ts` 的 `startSession` 又被呼叫端繞過而直接 import
`apps/api/src/http/session-start.ts` 的實作；
任一成立表示 session 又變回頁面的能力，或認證路由又離開了模組宣告，須重開本決策。
