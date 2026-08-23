# 24 — 舊版訂單事件下線

**What to build:** 舊版本的訂單事件停止發出。這是金額模型 expand–contract 的最後一步，只有在確認沒有任何訂閱者仍依賴舊版之後才執行。

**Blocked by:** 23

**Status:** ready-for-agent

- [x] repo 內確認：沒有任何訂閱者仍訂閱舊版本事件（2026-08-23，下方記錄）
- [ ] 外部部署確認：這一台查不到，需要對每個部署各跑一次（下方有指令）
- [ ] 舊版本事件停止發出，事件目錄移除它
- [ ] 所有整合測試全綠

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

**因此工單 24 的前置條件目前是「repo 內已確認、外部未確認」。** 要下線之前，
需要一份實際部署的清單，逐一跑上面那條指令，並向每個下游確認有沒有人直接讀 outbox。
