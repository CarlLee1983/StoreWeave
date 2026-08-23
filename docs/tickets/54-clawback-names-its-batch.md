# 54 — 取消訂單扣回購物金要指名批次

**What to build:** 取消訂單時扣回累積的那筆負分錄要指名它要扣哪一批，而不是丟進「先到期先用」的分配裡扣到別批去。範圍是購物金帳本的推導與回沖那一段；等級積分不分批，不在這一票。

**Blocked by:** 40, 42

**Status:** done

- [x] `loyalty_reward_entries` 加 `batch_id`：負分錄可以指名它扣的是哪一批
- [x] `deriveRewardBalance` 遇到指名的分錄只扣那一批，不排 `byExpiryThenAge`
- [x] 指名的批次剩不夠時，剩下的部分丟掉且不算 `shortfallCents`——那筆錢已經花掉了
- [x] `rewardService.reverseForOrder` 的扣回指名那張訂單的 `order-accrual` 分錄
- [x] 既有的扣回列由 migration 回填 `batch_id`，推導只留一條路徑
- [x] `deriveRewardBalance` 不再以 `source === 'reversal'` 判斷是不是扣回
- [x] ADR 記下「指名批次是先到期先用的例外」，0019 留下指標

審查之後補的：

- [x] 指名扣不到的量以 `unappliedClawbackCents` 回報，`balanceFor` 以 `warn` 記它——
  不去別批補是這張票的本體，但那個差額不能沒有人查得到
- [x] 資料庫擋掉三種錯誤指名：跨顧客（複合外鍵）、指名自己、正分錄帶 `batchId`
- [x] 回填拆成 `0005_backfill_clawback_batch` 走 `migrate` 階段，
  不與 DDL 的 ACCESS EXCLUSIVE 擠在同一個交易裡
- [x] `RewardEntry.source` 拿掉——推導不再讀它，留著只會讓人猜它還有別的用途
- [x] 測試補上四個邊界（同一批被兩筆指名、指名負分錄、指名別人的批次、零元）、
  `batch_id` 的直接斷言，以及回填 SQL 本身

## 這是什麼問題

`docs/tickets/README.md` 的「已知、刻意沒做的」記了這一條。回沖寫的是一筆金額對的、
但**不指名批次**的負分錄（`service.ts` 的 `reverseForOrder`）：

```ts
amountCents: -clawedBackCents,
source: 'reversal',
reference: `clawback:${orderId}`,
```

推導那一端（`balance.ts`）只知道「這是一筆扣回」，於是照 `byExpiryThenAge` 找批次來扣。
它扣掉的是**當下最先到期的那一批**，而那通常不是這張訂單累積的那一批。

具體會怎麼壞：顧客有一批客服補償的 300 元（下週到期），又下了一張單累積 100 元
（七天後生效、一年後到期）。那張單取消，扣回 100 元扣的是客服補償那一批——
補償被吃掉 100，而訂單累積的 100 原封不動留著，一年後還在。金額總數對得起來，
**歸屬完全錯了**：顧客損失的是他本來就該有的錢，留下的是他不該有的錢。

## 為什麼今天沒有炸

累積發生在付款完成（`accrueForOrder` 由付款事件觸發），而取消只允許 pending 的訂單，
兩條路徑走不到一起——`clawedBackCents` 今天恆為 0，`reverseForOrder` 只會走到退還折抵那一半。

所以這是一張**修設計而不是修災情**的票。部分退貨進模型的那天，累積與取消就會相遇，
而到那時候這件事會混在一堆新東西裡，不會有人記得它是舊的。

## 決定：指名批次，不留退路

負分錄多一個 `batch_id`。有指名就只扣那一批，扣不到就算了；沒指名的還是走
「先到期先用」——折抵本來就該這樣，顧客花的是「手上最快過期的錢」。

**不讓指名的扣回在扣不夠時退回去掃別批。** 扣不到代表那筆錢已經被花掉了，
而那正是回沖扣不回來的合法結果；退回去掃別批就是把這張票要修的行為原樣裝回來。

**既有的扣回列回填而不是留一條相容路徑。** `reference` 是 `clawback:<orderId>`，
對應的累積是 `(source='order-accrual', reference=<orderId>)`，一對一查得到，
回填是確定的。留兩條路徑的成本是推導那支函式從此要同時說明兩種扣回，
而它是這個模組唯一複雜的地方。

回填理論上會改到歷史餘額（舊的 FIFO 扣回可能扣在別批上）。實務上不會：上一段說的
「今天走不到」代表正式環境的扣回列數是 0，這段 SQL 是為了讓不變式成立，不是為了搬資料。

## 順帶收掉的一件事

推導那一端目前以 `entry.source === 'reversal'` 判斷「這是扣回」。指名之後這個判準
換成「有沒有 `batchId`」——推導不必再認得來源字串，而來源字串本來就是服務層的詞彙。
