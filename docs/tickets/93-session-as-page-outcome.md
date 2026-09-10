# 93 — 頁面可以把「請簽發 Session」當成回傳值交出去

**What to build:** 模組宣告的頁面多了一種收場方式：除了「渲染這個畫面」「轉到那裡」「找不到」之外，它可以回答「請簽發這個 Session 然後轉到那裡」或「請清掉 Session 然後轉到那裡」。路由層收到這兩種回答時負責寫 cookie、合併訪客購物車、送出轉址。頁面本身仍然碰不到請求或回應物件。

這一票沒有任何頁面使用這個能力——它是「先把新形狀放好，舊的照舊」，所以使用者看不出差別。

**Blocked by:** 92

**Status:** ready-for-agent

- [ ] 頁面的 outcome 多出 `session-start` 與 `session-clear` 兩個具名變體，名字與契約既有的 cookie 效果詞彙一致
- [ ] 頁面解析時拿得到的東西一個都沒有增加——特別是沒有新增 session 入口、沒有 runtime、沒有請求物件
- [ ] 路由層收到這兩種 outcome 時，簽發與合併都經過 92 建立的那個唯一入口
- [ ] 頁面註冊的既有守衛照舊：重複的 page id 與 path 仍是組裝錯誤，缺必需版型仍在啟動時被拒絕

## 邊界

這是 expand，不是 migrate。舊的 decorator 路由這一票完全不動，`SYSTEM_PAGE_IDS` 也不動。
