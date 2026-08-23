# 24 — 舊版訂單事件下線

**What to build:** 舊版本的訂單事件停止發出。這是金額模型 expand–contract 的最後一步，只有在確認沒有任何訂閱者仍依賴舊版之後才執行。

**Blocked by:** 23

**Status:** done

- [x] repo 內確認：沒有任何訂閱者仍訂閱舊版本事件（2026-08-23，下方記錄）
- [x] 外部部署確認：**不成立**——使用者 2026-08-23 確認還沒有正式部署（下方記錄）
- [x] 舊版本事件停止發出，事件目錄移除它
- [x] 所有整合測試全綠

## 訂閱者盤點（2026-08-23）

**這個 release 裡的全部訂閱者只有兩個**，兩個都不在舊版事件上：

| 訂閱者 | 訂閱的事件 |
| --- | --- |
| core:coupon | `commerce.customer.registered.v1` |
| ext:demo-erp | `commerce.order.paid.v2` |

做法是走 `coreModules()` 的 `subscribers` 與 `AVAILABLE_EXTENSIONS` 每一份 manifest 的
`subscribedEvents`，也就是 `runtime.ts` 與 `extension-host.ts` 實際註冊進 EventBus 的兩個來源。
`commerce.order.placed.v1` / `.v2` 與 `paid.v1` 在整個 repo 只出現在 `order/src/events.ts`
的定義與發出處，沒有任何一處消費。

**「外部訂閱者」只可能是三種形狀**，因為投遞是行程內的：worker 讀 outbox，交給
`events.subscribersFor(name)` 拿到的那些 handler，平台沒有 webhook、沒有對外轉發。

1. 別人的 build 裡自帶的 Extension 訂閱了那三個名字之一；
2. 有人直接讀那座部署的 `platform_outbox`（或 DB replica）；
3. 有人在解析日誌。

第 1 種每座部署自己答得出來——在該主機上跑：

```bash
commerce extension:list --json   # 看每一支的 subscribedEvents
```

輸出可以直接接管線——日誌走 stderr（`commerce extension:list --json | jq '.items[].subscribedEvents'`）。

第 2、3 種沒有任何程式化的辦法可以查出來：outbox 是一張表，誰 SELECT 過它不會留下痕跡。
那是一個要去問人的問題，不是一個查得到的問題。

**因此工單 24 的前置條件一度是「repo 內已確認、外部未確認」**，要下線之前需要一份
實際部署的清單，逐一跑上面那條指令，並向每個下游確認有沒有人直接讀 outbox。
那份清單後來不需要了，理由見下一段。

## 外部確認的結果（2026-08-23）

**問題不成立：這套系統還沒有正式部署**（使用者確認）。上面那三種形狀全部依賴「有一座
跑起來的部署」——投遞是行程內的，沒有行程就沒有訂閱者；沒有資料庫在跑，就沒有
`platform_outbox` 可以被 SELECT，也沒有日誌可以被解析。清單是空的，逐台跑指令這件事
因此沒有對象。

repo 內的那一半在下線當天重驗過一次仍然成立（不是引用 2026-08-23 那筆記錄，是重跑）：
`tests/unit/retired-order-events.test.ts`（下線時由 `legacy-order-event-subscribers.test.ts`
改名而來）綠，三個名字在 repo 裡只出現在
`order/src/events.ts` 的定義與發出處以及測試的斷言裡。

## 下線做了什麼

- `order/src/events.ts` 移除 `orderPlacedV1`、`orderPlacedV2`、`orderPaidV1` 的定義，
  `orderEvents` 只剩 `placed.v3`、`paid.v2`、`cancelled.v1`。
  `lineWithDiscountSchema` 併回 `lineSchema`——它原本存在只是為了讓新舊版共用行的形狀。
- `order/src/commands.ts` 移除三處 `ctx.publish`。一張訂單走完下單與付款，
  outbox 從五列變成兩列。
- **ADR 0017 隨之失效**（它的 Falsified if 第二個條件就是這件事），狀態改為 obsolete，
  全文保留——它記的是一次對 ADR 0006 的刻意偏離，沒有那段記錄，之後的人看到
  「舊版事件語意變了」只會當成 bug。
- **ADR 0006 補了一段前提**（審查發現）：它明文要求「發 `.v2` 時 `.v1` 至少再保留一個
  minor 週期」，而 `package.json` 是 `0.1.0`、`git tag` 是空的——那個週期從來沒開始過。
  這次下線因此是對 0006 的偏離，理由本來只活在這張工單裡。補的那段把規則沒寫出來的
  前提寫出來：一個 minor 週期從第一個 release 起算，在那之前可以立即下線；
  進入 `1.x` 或出現第一個 tag 之後這個豁免收回。
- `tests/unit/legacy-order-event-subscribers.test.ts` 換了工作並改名為
  `tests/unit/retired-order-events.test.ts`：原本守下線的**前置條件**（沒有訂閱者），
  現在守那三個名字不會被加回來（不在事件目錄、也沒有人訂閱）。
- `docs/extension-development.md` 的三處範例、`docs/architecture.md` 與 `README.md`
  改用 `paid.v2`。其中 extension 文件那份宣稱在展示 demo-erp 的 manifest，
  但那支早在工單 23 就遷到 `paid.v2`——那一處在這張票之前就已經是錯的。

`docs/adr/0009`、`0015` 與 `docs/specs/0002` 裡提到舊版名字的地方**不動**：
那幾份記的是當時的決定，改掉會讓歷史對不上。

## 既有 outbox 舊列會怎麼樣（審查發現）

正式環境是空的，但開發機的 `platform_outbox` 可能還存著 `placed.v1` 那些列。
它們**不會卡住任何東西**：`relayOutbox()` 對每一列呼叫 `subscribersFor(event.name)`，
那是一個 `filter`，未知名字回空陣列而不是拋錯；投遞迴圈跑零次，接著照樣
`markRelayed`。所以舊列會被安靜地排空並標記成已轉送，不阻塞、不進死信。

會拋的兩個地方都碰不到：`EventBus.parse()` 的 `getEvent` 只發生在
`event-delivery.ts`，而那支 handler 只有在有訂閱者時才排得進來；`command-bus.ts`
的 `getEvent` 是發布時驗證，只擋新的發出。也不會有已排入未執行的投遞工作——
那三個名字從來沒有訂閱者。

`markRelayed` 之後那些列的內容就再也送不出去了。這是刻意的：它們的訂閱者不存在，
重送也沒有對象。
