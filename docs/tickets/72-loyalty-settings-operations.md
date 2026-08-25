# 72 — 會員等級與購物金設定的營運介面

**What to build:** 等級門檻與購物金規則是店家維護的商業資料，現在卻只能改程式碼或進資料庫。
`commerce.loyalty.saveTier`、`removeTier`、`listTiers`、`updateRewardSettings`、
`getRewardSettings` 五支都已註冊，但 `apps/api/src/controllers/` 底下沒有 loyalty controller，
後台也沒有頁面。README 記的那批預設值（回饋 1%、付款後 7 天生效、365 天到期）事實上是寫死的。

**Blocked by:** —

- [ ] 新增 loyalty 的 HTTP 面，涵蓋等級的列出／儲存／移除與購物金設定的讀取／更新
- [ ] 確認權限鍵：`saveTier` 與 `removeTier` 目前沿用 `promotion:write`，`listTiers` 與
      `getRewardSettings` 沒有 permission。決定它們該不該有自己的 `loyalty:*`，理由寫進工單
- [ ] 後台頁可維護等級門檻與購物金倍率，並顯示改動只影響之後的累積、不回溯既有 ledger
- [ ] 移除等級要擋下仍有會員落在該級距的情況，或明確說明降級後果，不靜默生效
- [ ] 補 bus integration 與 jsdom 測試，涵蓋門檻重疊、負值與移除的閘門

## 不做的事

- 等級的專屬 Promotion 綁定 UI（工單 45 已落地，這裡只調門檻與倍率）、多幣別的購物金設定。
