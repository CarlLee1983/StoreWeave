# 53 — Command / Query Bus 記下執行時間

**What to build:** 每一次 Command 與 Query 的執行都留下耗時，讓「這條路徑慢不慢」變成查得到的事。範圍只有兩支 Bus 的 `execute()`；Worker 的事件投遞與背景工作不在這一票。

**Blocked by:** —

**Status:** ready-for-agent

- [ ] `CommandBus.execute()` 與 `QueryBus.execute()` 記下耗時，欄位沿用既有的 `latencyMs`（`db/src/client.ts` 與健檢已經是這個名字）
- [ ] 失敗的那次也要有數字：逾時與慢查詢往往就是失敗的那幾筆，只記成功等於把最需要的樣本丟掉
- [ ] 決定 Query 成功時要不要每次都寫一行，以及寫在哪個 level（見下）
- [ ] 有一條測試真的斷言那個欄位出現在 log 裡，而不是只斷言函式跑得完
- [ ] `docs/operations.md` 說明怎麼從 log 撈這個數字

## 為什麼現在需要它

`docs/tickets/README.md` 的三筆效能債，結論都是「先量再改」——但這個 repo 現在量不到自己：

- `CommandBus` 只在成功時寫一行 `command executed`（`command-bus.ts:165`），帶 `owner`，沒有耗時；
- `QueryBus` 成功時**一行都不寫**。

所以那句「先量再改」今天不是待辦，是一句空話。這張票把它變成可執行的。

## 要先決定的事

**Query 的日誌量。** 前台每渲染一次就會打好幾支 Query，逐次寫 info 會把日誌淹掉。三個選項：
寫 debug（預設看不到，要查時調 level）、只在超過門檻時寫 warn（門檻要有人選）、
或永遠寫 info 但接受量。這是這張票唯一需要拍板的決定，做之前先問。

**不要在這張票裡加指標系統。** Prometheus／OpenTelemetry 是另一個決定，會帶進新的相依與部署面。
先把數字寫進既有的結構化日誌——那是今天就有的東西，而且三筆效能債要的只是「哪一支慢」的量級。

## 這張票做完之後

三筆效能債才輪得到動手：先量 `toCartDto`、`listMyCoupons`、`promotionPerformance` 的實際耗時，
再決定要不要做批次查詢與餘額快照。沒有數字就改，只會加進一個看不出效果的複雜度。
