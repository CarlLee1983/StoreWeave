# 59 — 綠界物流 Adapter：建單、標籤與追蹤號

**What to build:** 以既有 Shipping provider contract 建立第一個綠界物流 adapter，支援已付款訂單的
宅配建單、取得 provider reference／追蹤號與可下載標籤。核心 Order 與 Shipping module 不得直接
依賴綠界 HTTP 格式，日後可用另一 adapter 取代。

**Blocked by:** 58

**Status:** ready-for-agent

- [ ] 將綠界物流設定與機密放在 extension config／secret provider，提供 contract test 與 health check
- [ ] 建單以 shipment 與 provider idempotency key 為邊界；重試不產生第二張託運單
- [ ] 將 provider reference、tracking number、標籤安全地保存到 shipment；標籤僅授權後台下載
- [ ] 外部呼叫採 job／outbox 或等價可重試路徑，不包在長資料庫 transaction
- [ ] provider 失敗有可見、可重試的營運狀態；不把 Order 改回未付款
- [ ] 以 fake provider 覆蓋成功、timeout、重試與重放；以 UAT 證明一筆真實建單

## 不做的事

- 門市選店（60）、後台出貨 UI（61）、物流 callback（62）、多包裹與跨倉。
