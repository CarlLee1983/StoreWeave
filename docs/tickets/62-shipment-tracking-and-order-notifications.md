# 62 — 物流追蹤與訂單生命週期通知

**What to build:** 接收物流商簽名 callback／主動查件，將原始狀態正規化為 shipment stage，並透過
NotificationProvider 發送下單、付款、出貨、到貨通知；顧客在訂單頁看到可理解的配送進度。

**Blocked by:** 59, 61

**Status:** ready-for-agent

- [ ] callback 驗簽、冪等與狀態單向推進；原始 payload／狀態碼僅保留在營運記錄
- [ ] 無 callback 的 carrier 有可排程、可觀測、可重試的查件工作
- [ ] 訂單成立、付款完成、出貨、到貨各在正確領域事件後通知一次；發送失敗可重試但不回滾交易
- [ ] 訂單頁顯示標準 stage、追蹤號與安全的追蹤連結（若 provider 提供）
- [ ] 有 callback 重送、倒退狀態、通知重試、顧客資料隔離與全流程 integration 測試

## 不做的事

- 站內通知中心、行銷 EDM、客服聊天室。
