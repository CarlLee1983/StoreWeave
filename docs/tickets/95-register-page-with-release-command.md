# 95 — 註冊走模組宣告的頁面，註冊命令由 release 指定

**What to build:** 訪客在前台填完註冊表單就是登入狀態，購物站的註冊同時建立 Account 與 Customer，而且兩者仍然在同一筆交易裡——不會留下沒有 Customer 的孤兒帳號。認證模組不自己決定註冊要跑什麼，改由組裝它的 release 指定。

**Blocked by:** 94

**Status:** ready-for-agent

- [ ] 註冊的 GET／POST 由模組宣告，controller 上對應的 decorator 刪除
- [ ] 模組工廠接一個註冊命令參數；購物站傳入建立 Customer 的那一個
- [ ] 註冊完成即登入，並沿用 94 的轉址清洗
- [ ] 帳號與 Customer 仍在同一筆交易裡建立
- [ ] 信箱已存在時回中性訊息，不成為帳號枚舉的管道
- [ ] 註冊的節流行為不變

## 邊界

形象站的組裝留到 97。這一票只讓購物站走通。
