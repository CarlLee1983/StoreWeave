# 53 — Command / Query Bus 記下執行時間

**What to build:** 每一次 Command 與 Query 的執行都留下耗時，讓「這條路徑慢不慢」變成查得到的事。範圍只有兩支 Bus 的 `execute()`；Worker 的事件投遞與背景工作不在這一票。

**Blocked by:** —

**Status:** done

- [x] `CommandBus.execute()` 與 `QueryBus.execute()` 記下耗時，欄位沿用既有的 `latencyMs`
- [x] 失敗的那次也有數字，計時從最上面起算（授權與輸入驗證都算進去）
- [x] 冪等重放也有數字（`replayed: true`）——它走交易內的捷徑，最容易被漏掉的就是它
- [x] 用單調時鐘（`performance.now()`）：`Date.now()` 會被 NTP 校時往回拉
- [x] 拍板了 Query 的 level：成功走 `debug`、慢的升 `warn`（下方「拍板」）
- [x] 測試真的斷言 log 上有那個欄位：整合測試打快與 4xx，單元測試打慢與 5xx
- [x] `docs/operations.md` 說明怎麼從 log 撈這個數字

## 為什麼現在需要它

`docs/tickets/README.md` 的三筆效能債，結論都是「先量再改」——但這個 repo 現在量不到自己：

- `CommandBus` 只在成功時寫一行 `command executed`（`command-bus.ts:165`），帶 `owner`，沒有耗時；
- `QueryBus` 成功時**一行都不寫**。

所以那句「先量再改」今天不是待辦，是一句空話。這張票把它變成可執行的。

## 拍板（2026-08-23）

**Query 成功走 `debug`，超過 500ms 升 `warn`。** 兩個都要：逐次 `info` 會把日誌淹到沒人讀，
但只在超過門檻時才寫，等於平常什麼都沒有——要回答「這支平均多久」時就沒有樣本可看。
分成兩個 level 之後，預設看得見的是異常，要看全貌把 `logging.level` 調成 `debug`。

| | 一般 | 達到 `SLOW_CALL_MS`（500ms） |
| --- | --- | --- |
| Command 成功 | `info`（本來就有那行） | `warn` |
| Query 成功 | `debug` | `warn` |
| 失敗 4xx | `debug` | `warn` |
| 失敗 5xx | `error` | `error` |

4xx 停在 `debug`：那是呼叫端送錯東西，不是這座部署的問題，吵起來只會讓真的問題被蓋掉。
5xx 走 `error` 而不是 `warn`，與 `exception.filter.ts` 對齊：Bus 是所有通道的共同咽喉，
以 `level >= error` 設告警的部署不該只抓到走 REST 的那一半。
門檻寫死成常數而不是設定——沒有任何一座部署提過不同的數字，真的有人要再開成設定。

規則寫在 `contracts/src/timing.ts` 的 `logBusCall()`，兩支 Bus 共用：
各寫一次遲早會有一邊漏掉 `latencyMs` 或選了不同的 level。

**不要在這張票裡加指標系統。** Prometheus／OpenTelemetry 是另一個決定，會帶進新的相依與部署面。
先把數字寫進既有的結構化日誌——那是今天就有的東西，而且三筆效能債要的只是「哪一支慢」的量級。

## 這張票做完之後

三筆效能債才輪得到動手：先量 `toCartDto`、`listMyCoupons`、`promotionPerformance` 的實際耗時，
再決定要不要做批次查詢與餘額快照。沒有數字就改，只會加進一個看不出效果的複雜度。
