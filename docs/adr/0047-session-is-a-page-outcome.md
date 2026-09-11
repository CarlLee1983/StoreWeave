# 0047. Session 是頁面的 outcome，不是頁面的能力

- 狀態：accepted（2026-09-11，工單 92–98 完成、單元與整合回歸全綠）。下面「Falsified if」
  第四條在定案當下就是違反狀態——`startSession` 被三個呼叫端繞過——已於工單 92 消除；
  其餘條件由工單 93–98 逐一兌現。
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

**登入頁用 `bindPorts` 取得認證能力。** 這一條在定案時沒有想到：`resolve` 要驗密碼，
而 `authenticate` 不是 Command（認證發生在 Actor 存在之前），`PageResolveContext` 又不該
長出它——那正是上面拒絕的東西。答案是既有的機制：`PlatformPorts` 多一個 authentication
port，模組在 `bindPorts` 拿到它，頁面閉包持有。這是模組層的相依，不是請求層的能力，
所以 ADR 0045 的條件仍然成立。資料庫握柄由綁定那一端補上，模組看不到它。

同樣的形狀之後也適用於註冊與密碼重設所需的服務。這條路的代價是 kernel 的 `PlatformPorts`
會隨著模組需要的平台能力增長；界線是「不是 Command 也不是 Query 的平台服務」，
而不是「模組想要的任何東西」。

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

**theme 的 auth view 拆成四個。** 定案當下 `ThemeAuthView` 是一個四模式的 discriminated
union，因為只有一個 renderer。拆成九個 page（四組 GET／POST 加 logout）之後，每個 renderer
都會收到一個它只處理其中一支的 union，所以型別跟著頁面拆開（工單 98：四個型別改由
`packages/platform/auth/src/pages.ts` 擁有，kernel 的 `SYSTEM_PAGE_IDS` 只剩錯誤頁）。
theme 的 renderer map 多八個 key，實際渲染函式仍是四個——`commerce.content.contact` 與 `commerce.content.submitContact` 指向
同一個函式已經是既有先例。`logout` 設 `required: false`（只轉址、沒有畫面）。REST 版的
logout（`apps/api/src/controllers/auth.controller.ts`）原樣保留：它的呼叫端要 JSON，
表單版要 303，合併只會逼出一個判斷 Accept header 的分支。

**`ReleaseHttpAdapter.startSession` 成為唯一入口。** 定案當下這個 hook 存在卻被繞過三次——
前台的登入與註冊表單、顧客 REST 註冊都直接引用 commerce 版的實作。工單 92 把三處都改回經過
adapter，並移除形象站那份不合併購物車的重複實作：合併與否改成問命令註冊表，也就是問「這個
網站有沒有購物車」。沒有改成「cart 模組監聽登入事件自己合併」，
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

工單 94 一併決定的三件事：登出不再是 CSRF 豁免的（表單本來就送得出 `_csrf` 欄位，而
CSRF 只在 session 解析成功時才檢查，所以過期 session 的登出照樣走得通——原本的豁免
理由已經不成立）；用 Bearer token 認證的呼叫端打登出維持無操作，與 REST 版一致；
簽發失敗不回滾，session 已經寫進資料庫、cookie 也可能已掛上 reply，路由層只保證不送轉址。

連帶的行為變更：登入與登出從強制匿名變成 session-or-anonymous。忘記密碼與重設密碼
那四頁同樣如此——舊的 decorator 都掛 `@Anonymous()`，工單 96 搬過來之後一併變了，
這裡補記（工單 96 的回顧）。資料驅動的路由目前沒有 per-page 的強制匿名——這是現況
而不是結論。它的代價是三個情境：停在匿名登入頁的分頁（表單裡沒有 `_csrf`，
因為匿名時沒有 token）在別的分頁登入之後送出會得到 403；登入後按上一頁回到
表單再送出同樣 403；以及在前台換登另一個帳號必須先登出。要消掉這些就得讓頁面宣告得出
「這一頁一律當訪客」，那是一個新的介面決定，留待有人真的需要時再開。

**誰算「已經登入」由 release 決定。** 登入頁看到已登入的人會把他轉走，但「已登入」不能寫死
成任何 actor type：購物站的會員是 customer，形象站的 member 是 user。寫死成兩者皆可會讓
營運者逛前台時被判成已登入，於是在登入頁與會員頁之間互踢成無限轉址。同一個問題的另一半
在路由層：已經是真身分卻不符這一頁的 audience 時回 403，而不是再送去登入頁。

## Falsified if

`packages/platform/kernel/src/page.ts` 的 `PageOutcome` 失去 `session-start` 與
`session-clear` 這兩個 kind，或它的 `PageResolveContext` 反過來長出任何 session 入口；
或 `packages/platform/kernel/src/page.ts` 的 `SYSTEM_PAGE_IDS` 重新出現 `platform.auth`；
或 `apps/api/src/storefront/storefront.controller.ts` 重新以 decorator 列出任何 auth 路由；
或 `apps/api/src/release-adapter.ts` 的 `startSession` 又被呼叫端繞過而直接 import
`apps/api/src/http/session-start.ts` 的實作；
或 `packages/platform/kernel/src/module.ts` 的 `PlatformPorts` 長出請求層的東西——actor、
請求或回應物件、資料庫握柄——那會讓模組層的能力入口變成另一個 `PageResolveContext`；
任一成立表示 session 又變回頁面的能力，或認證路由又離開了模組宣告，須重開本決策。
