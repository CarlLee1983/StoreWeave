# 0030. `awaiting_payment` 與依付款方式而異的預留期限

- 狀態：accepted
- 更新（2026-08-25，工單 75）：文中的 `markPaid` 指的是那支同名 command。它已經移除——
  含測試在內沒有任何呼叫端，付款結果一律走 `recordPaymentResult`。這篇描述的前置狀態放寬
  現在由 module 內部的 `markOrderPaid` 承擔，決定本身不變，`Falsified if` 已改指新的符號。
- 日期：2026-08-24
- 修訂：ADR 0009（狀態機與 15 分鐘預留的部分）

## 背景

ADR 0009 的付款模型有兩個前提，接上真實金流之後都不再成立。

其一，**付款是秒級的**。`payOrder` 轉 `payment_processing`、worker 在交易外呼叫
provider、成功後 `markPaid`——整段以秒計，所以「訂單保留 15 分鐘」是一個寬鬆的上界。
但綠界的付款方式有一半是**非即時**的：ATM 虛擬帳號、超商代碼、超商條碼，
使用者當下只拿到一組號碼與繳費期限，可能兩天後才去繳。綠界會先打一次取號通知
（`PaymentInfoURL`，帶虛擬帳號或繳費代碼與 `ExpireDate`），真正付款後才打付款通知。
用 `payment_processing` 表達那兩天，等於讓到期工作無從分辨該不該回收庫存。

其二，**付款一定經過金流商**。代收貨款沒有金流訂單——錢是取貨當下在超商付的，
物流單上一個旗標就是全部。這種訂單從來不會進 `payment_processing`，
而 `markPaid` 現在只接受那一個狀態。

另外，綠界不會通知繳費逾期，逾期回收得自己來。

## 決策

**新增 Order 狀態 `awaiting_payment`**：已經送出去、在等人去繳錢。
非即時付款取號完成後進這個狀態，代收貨款的訂單建立物流單後也進這個狀態。

`markPaid` 的前置從 `payment_processing` 放寬為 `payment_processing | awaiting_payment`。
`actor.type === 'system'` 的要求維持不動——付清仍然只能由系統造成。

**預留期限成為參數**，不再是固定的 15 分鐘：即時付款 15 分鐘、
`awaiting_payment` 用金流商回的繳費期限、代收貨款用運送方式上的設定。
到期工作維持 ADR 0009 的「一單一支」，只是延後時間不同；取號回呼進來時
重排那支工作（`dedupeKey` 已經能處理）。

付款方式因此在結帳頁由店家這一側先選定，不交給金流商的收銀頁——
若送出時填「全部付款方式」，在導轉出去到回呼進來這段期間**無法決定**這張單的
庫存要留 15 分鐘還是三天，只能一律按最長的留。

## 考慮過的選項

- **代收貨款走一條獨立的 `markCollected` command。** 否決：「訂單付清」會有兩個入口，
  而那個 handler 同時負責庫存 commit、購物金累積、發 `paid.v2`，兩份必然漂掉。
  超商取貨與 ATM 的差別在通路不在狀態，兩者都是「已經送出去、在等人繳錢」。
- **代收貨款的訂單建立時就進 `payment_processing`。** 否決：那是謊話，
  而且 15 分鐘的到期工作會把它殺掉。
- **改成週期性掃描到期訂單（ADR 0016 的時間切片慣例）。** 否決：一單一支的模型
  已經運作、已經有 `dedupeKey`、已經證明過與付款確認鎖同一張 Order——
  那是 ADR 0009 的核心保證，改成掃描要重新證明一次互斥。

## 後果

- 訂單狀態從五個變六個。`expired` 的語意不變（預留到期），但它現在可能來自
  三種不同長度的期限。
- **總額 0 元的訂單跳過金流商**：購物金可以把商品小計折到 0，配上滿額免運，
  總額就是 0，而綠界的 `TotalAmount` 必須大於 0——現在的程式沒有任何防線，
  會照樣把 `amountCents: 0` 送出去（`packages/commerce/order/src/commands.ts` 的
  `payOrder`）。0 元訂單由系統直接 `markPaid`，付款紀錄的 provider 記為 `internal`：
  沒有向任何金流商收錢，就不該寫成綠界。代收貨款的 0 元訂單同樣走這條，
  且物流單不帶代收旗標。
- 付款方式進 Order 快照，理由與收件資訊、運費快照相同：事後查得回來。
- ADR 0009 的「Falsified if」不受影響——`payOrder` 仍然不在交易內呼叫 provider，
  庫存仍然以 `on_hand - reserved` 驗證可售量。這篇改的是那個模型的**時間尺度**
  與**入口數量**，不是它的形狀。

## Falsified if

`packages/commerce/order/src/dto.ts` 的 `orderStatus` 拿掉 `awaiting_payment`，
或 `packages/commerce/order/src/commands.ts` 的 `markOrderPaid` 回到只接受單一前置狀態，
或到期工作改由週期性掃描取代一單一支。

前兩者代表非即時付款與代收貨款已經不在支援範圍，第三者代表 ADR 0009 的互斥保證
已經改由別的機制承擔——任一成立，這篇要重新檢視。
