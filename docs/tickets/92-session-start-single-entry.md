# 92 — 開始 Session 的唯一入口是 release adapter

**What to build:** 登入之後「簽發 cookie、合併訪客購物車、給出提示」這一連串動作，不論是後台 REST 登入、前台表單登入還是顧客 REST 註冊，都走同一條路。今天三個呼叫端各自直接引用購物站的實作，繞過了 release adapter 上那個本來就為此存在的 hook；形象站因此長出一份不合併購物車的重複實作。這一票沒有新功能，使用者看不出差別——它讓「這個 release 登入時會發生什麼」重新只有一個答案。

**Blocked by:** —

**Status:** done

- [x] 前台登入表單、前台註冊表單、顧客 REST 註冊都經過 adapter，沒有任何呼叫端直接引用購物站的實作
- [x] 形象站那份不合併購物車的 `startSession` 實作移除；合併與否由「這個 release 有沒有購物車模組」決定
- [x] 既有的登入、註冊與購物車合併行為完全不變——`auth-http` 與 `cart-merge` 的既有案例原封不動通過
- [x] 形象站的登入路徑仍然不要求載入購物車模組

## 為什麼先做這一張

[ADR 0047](../adr/0047-session-is-a-page-outcome.md) 的 falsification 條件有一條是「adapter 的
`startSession` 又被呼叫端繞過」——那條現在就是違反狀態。不先修掉，這份決策一落地就自我否證。

這也不只是潔癖：形象站那份重複實作之所以會長出來而沒被發現，正是因為沒有人真的透過那個 hook 走。
