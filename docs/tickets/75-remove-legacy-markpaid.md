# 75 — 移除沒有呼叫端的 `commerce.order.markPaid`

**What to build:** `commerce.order.markPaid` 註冊在 order module 裡、標記 system-only，
但整個 repo 含測試沒有任何呼叫端——付款成功實際走的是 `recordPaymentResult`。它內部還留著
一段「legacy callers without an attemptRef」在補建 `legacy:` 開頭的 payment attempt，
那是 payment attempt 模型（ADR 0009、0030）之前的路。依 coding-style 的「不留相容層」，
它該被刪掉，而不是留著等人以為它是活的。

**Blocked by:** —

- [ ] 再次確認沒有呼叫端：repo 內、CLI、extension 與任何既有部署的設定
- [ ] 移除 command、handler、input schema 與 module 註冊；`legacy:` attempt 那段一併刪
- [ ] 確認 `recordPaymentResult` 覆蓋了 markPaid 曾經負責的每一條轉換，測試補上缺的那些
- [ ] 若最後決定保留，改成在原地寫明它服務哪一個外部呼叫端，並補一支測試守住

## 為什麼是一張工單而不是順手刪

刪掉一支已註冊的 bus command 是公開介面的變更。這套系統還沒有正式部署（見工單 24 的結論），
所以現在刪的代價最小——但那正是要留紀錄的理由：日後有人翻到 ADR 0009 會問「那 markPaid 呢」。
