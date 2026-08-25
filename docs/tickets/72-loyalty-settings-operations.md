# 72 — 會員等級與購物金設定的營運介面

**What to build:** 等級門檻與購物金規則是店家維護的商業資料，現在卻只能改程式碼或進資料庫。
`commerce.loyalty.saveTier`、`removeTier`、`listTiers`、`updateRewardSettings`、
`getRewardSettings` 五支都已註冊，但 `apps/api/src/controllers/` 底下沒有 loyalty controller，
後台也沒有頁面。README 記的那批預設值（回饋 1%、付款後 7 天生效、365 天到期）事實上是寫死的。

**Blocked by:** —

**Status:** completed

- [x] 新增 loyalty 的 HTTP 面，涵蓋等級的列出／儲存／移除與購物金設定的讀取／更新
- [x] 確認權限鍵（決定與理由見下方「權限鍵怎麼拍板的」）
- [x] 後台頁可維護等級門檻與購物金倍率，並顯示改動只影響之後的累積、不回溯既有 ledger
- [x] 移除等級要擋下仍有會員落在該級距的情況，或明確說明降級後果，不靜默生效
- [x] 補 bus integration 與 jsdom 測試，涵蓋門檻重疊、負值與移除的閘門

## 權限鍵怎麼拍板的

開票時寫「`listTiers` 與 `getRewardSettings` 沒有 permission」是錯的——那是掃描漏讀了跨行定義。
實際上 `listTiers` 是 `catalog:read`，原始碼註解寫明「等級是公開資訊：顧客要看得到下一級有什麼
才有努力的方向」；`getRewardSettings` 是 `promotion:read`。

**決定：只有寫入拿新的 `loyalty:write`，讀取兩支原地不動。**

寫入要搬，是因為改累積比例會直接改動購物金這本負債帳（ADR 0019：餘額是 ledger 的推導值），
那與編一檔活動不是同一種授權，共用 `promotion:write` 會讓權限集合說謊。

讀取不搬，是因為兩支各自的權限都有理由，而動它們要付的代價是真的：把 `listTiers` 改成
`loyalty:read` 會讓前台看不到等級——`storefront` 角色有 `catalog:read` 而不會有 `loyalty:read`。
`getRewardSettings` 留在 `promotion:read` 則是取捨：拿得到後台促銷頁的人本來就看得到這些規則，
另開一個 `loyalty:read` 只會多一個沒人發得出去的鍵。代價寫在 `queries.ts` 的註解裡——
日後若有角色只拿 `loyalty:write` 而沒有 `promotion:read`，這一頁會在載入時就掛掉。

沒有升級成 ADR：這是一個權限鍵的歸屬，可逆、也沒有一個後來的人會想「修掉」的反直覺之處。

## 不做的事

- 等級的專屬 Promotion 綁定 UI（工單 45 已落地，這裡只調門檻與倍率）、多幣別的購物金設定。
