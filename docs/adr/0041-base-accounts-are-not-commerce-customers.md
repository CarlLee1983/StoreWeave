# 0041. Base 帳號自成一個生命週期，Customer 由 commerce 擴充

- 狀態：accepted；B08 片2 實作，base-only HTTP 回歸通過。
- 日期：2026-09-09

`BASE_ROLES` 新增 `member`，而角色目錄多了一個 `account.selfServiceRegistration` 旗標，
指名這個 release 的自助註冊落在哪個角色。base release 因此可以註冊、驗證信箱、
換信箱、重設密碼、管理自己的 session，全程沒有任何 commerce 資料。

過去「前台身分」只有一條路：`commerce.customer.registerCustomer`，它在同一個交易裡
建立 `platform_users` 與 `commerce_customers`。結果是 base release 根本沒有可以自助
註冊的角色（`BASE_ROLES` 裡沒有 customer），而任何需要「有名字的人」的通用功能——
內容作者、通知收件人、之後 B13 的帳號頁——都被迫先變成一個顧客。

分開之後，commerce 的註冊維持原樣：它仍然同時建立帳號與 Customer，也仍然不帶
`selfServiceRegistration`，因為它要做的事比「建一個帳號」多。identity 不知道 Customer
存在，commerce 在帳號旁邊擴充它自己的資料。方向是 commerce → identity，不會反過來。

旗標放在角色目錄而不是設定或 HTTP 層，是因為註冊端點必須選一個角色，而「選哪個角色」
是權限決策。讓請求指定角色等於把權限決策交給呼叫端；讓 HTTP 層寫死角色名，則會讓
同一份 controller 在兩個 release 有兩種意思。目錄由 release 擁有，這件事已經是既有結構
（ADR 0037 的 release 選取），這裡只是把註冊也掛上去。至多一個角色帶這個旗標——
`AuthService` 在發現第二個時直接失敗，因為「看情況」在這裡沒有可辯護的語意。

`member` 的權限是空的：自助帳號能做的事都是對自己做的，走 `AuthService` 而不是
Command Bus，所以它不需要任何 permission key。之後若要讓 member 讀取通用資源，
權限要一個一個加上去，而不是先給一組再收回來。

## Falsified if

`packages/platform/authorization/src/roles.ts` 的 `BASE_ROLES` 不再包含可自助註冊的角色，
或 `account.selfServiceRegistration` 不再是選出註冊角色的依據（改由請求、設定或 HTTP
層決定），或 `packages/platform/identity/src/auth-service.ts` 的 `register()` 開始建立
commerce 的資料；任一成立表示 base 身分又變回商務資料的附屬品，須重開本決策。
