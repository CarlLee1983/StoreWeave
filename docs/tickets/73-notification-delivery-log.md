# 73 — 訂單與出貨通知的投遞紀錄

**What to build:** 工單 62 的生命週期通知送出去之後查不到。
`commerce.notification.listLifecycleDeliveries` 帶著 `notification:read`，而那個權限已經
發給 staff 與 readonly 了，但沒有 HTTP 端點也沒有後台頁面——通知有沒有送成、失敗原因是什麼，
營運看不到。形狀與工單 69 的發票相同：唯讀查詢面。

**Blocked by:** —

- [ ] `/api/v1/notification-deliveries` 提供列表查詢，可依訂單與狀態篩選
- [ ] 後台頁顯示事件、通道、收件對象的遮蔽值、狀態、嘗試次數與失敗原因
- [ ] 收件人資訊要遮蔽：查得到「送給誰」不等於把 email 與手機完整攤在營運頁上
- [ ] 補 HTTP 與 jsdom 測試，涵蓋篩選與無權限 token 的 403

## 不做的事

- 手動重送通知。重送要先決定「哪些通知重送是安全的」——出貨通知重送只是吵，付款連結重送
  會讓顧客拿到兩份。那是一個決策，不是一個按鈕，要開自己的工單。
