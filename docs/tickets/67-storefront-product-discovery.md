# 67 — 前台商品搜尋、篩選與分頁

**What to build:** 將既有 catalog 的搜尋 query 接到 Default Theme，提供顧客可理解、可分享連結的
搜尋結果、篩選與分頁；不在這張票引入新搜尋服務或推薦系統。

**Blocked by:** 56

**Status:** ready-for-agent

- [ ] 首頁或獨立搜尋頁提供關鍵字、可用的篩選條件與分頁，保留 query string
- [ ] 結果只顯示可公開購買的商品；空結果、無效頁碼與輸入跳脫有明確處理
- [ ] 搜尋、篩選、分頁與加入購物車共用既有 catalog／cart 契約，不複製資料或價格邏輯
- [ ] 補 storefront SSR、HTTP 與 escaping 測試，涵蓋 query 保留與存取控制

## 不做的事

- 商品分類資料模型、拼字校正、推薦、排序實驗與外部搜尋索引。
