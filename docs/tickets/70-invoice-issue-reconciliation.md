# 70 — 發票開立的對帳查詢：回應遺失時的補救

**What to build:** `ecpay-invoice` 的 `RelateNumber` 由固定的 `invoice:${id}` 推出
（`packages/extensions/ecpay-invoice/src/provider.ts`），而 provider 只有
`validateLoveCode / issue / void / healthCheck`，沒有查詢。若某次開立在綠界那一側其實成功、
回應卻沒收到（逾時、連線中斷），發票會停在 `issue_failed`，而之後每一次重送都會拿到
「RelateNumber 重複」的拒絕——稅務上那張發票已經開出去了，系統裡卻查不到號碼。
補上開立結果的主動查詢，讓重試先問「這張到底開了沒」再決定要不要送。

**Blocked by:** 58（正式環境／商家開通），以及綠界 B2C 查詢介面的實際契約

**Status:** blocked — 需要商家開通的查詢產品與 UAT 證據，不能由程式碼假設綠界那一側的欄位

- [ ] 以商家實際開通的查詢介面確認：可用 `RelateNumber` 或發票號碼查回開立結果
- [ ] 重試前先查詢；查到已開立就直接寫回 `issued`，不再送第二次 Issue
- [ ] 查詢失敗與「查無資料」要區分得開，前者可重試、後者才允許重送開立
- [ ] 以 fake provider 覆蓋「送出成功但回應遺失」這條路徑

## 為什麼現在不做

與工單 64 同一類：綠界那一側的能力與欄位要由商家開通後的 UAT 證實，不能先寫程式再對答案。
在補上之前，這個情境的補救是人工——到綠界後台查號碼，再以工單 69 的紀錄比對。
