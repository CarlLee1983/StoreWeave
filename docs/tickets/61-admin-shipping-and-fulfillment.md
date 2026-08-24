# 61 — 後台配送方式與出貨管理

**What to build:** 把現有 shipping methods／shipments API 接進 Admin，讓營運人員不必以裸 API
設定運費、建立託運單、下載標籤、推進出貨階段或處理失敗重試。

**Blocked by:** 59

**Status:** ready-for-agent

- [ ] Admin 有配送方式清單、建立與編輯頁，涵蓋費率、免運門檻、provider、type、啟停與輸入驗證
- [ ] Admin 訂單頁或出貨工作台顯示配送快照、shipment 狀態、provider reference、追蹤號、失敗原因與稽核時間
- [ ] 已付款、尚未出貨的訂單可建立／重試 shipment；不允許越過狀態機或編輯歷史 destination snapshot
- [ ] 標籤下載需 shipping 權限，URL／檔案不可外洩給顧客或未授權帳號
- [ ] 補 Admin component、HTTP 授權與 integration 測試

## 不做的事

- 倉儲揀貨、批次波次、拆單與多包裹。
