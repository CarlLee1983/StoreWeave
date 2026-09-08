# 0038. cron 時間運算用 croner，而且只用它的運算函式

- 狀態：accepted（B05 實作完成，2026-09-09）
- 日期：2026-09-08

## 背景

[ADR 0016](0016-recurring-jobs-by-time-buckets.md) 當年把週期性工作切成 epoch 對齊的時間切片，
明確否決了做 cron 進平台，理由是「目前的需求全部是固定間隔」。它同時記下兩個已知限制：
`everyMs = 24h` 的工作在 UTC 午夜跑而不是台北午夜，以及停機期間跨過的切片不會被追補。

[Spec 0009 F07](../specs/0009-complete-modular-base.md) 把那兩個限制變成必須交付的能力：
Asia/Taipei 午夜、具 DST 的時區、停機補一次／有上限追補、暫停與恢復。
切片機制表達不了這些，所以 B05 要引進 cron 運算。[ADR 0035](0035-retain-postgres-queue-for-modular-base.md)
已經定下不自製 cron parser，但沒指定用哪一個套件。

## 決策

用 **croner**，並且只把它當**純運算函式庫**：只呼叫 `nextRuns(n, from)`、`previousRuns(n, from)`、`match(date)`，
每次都傳入明確的時間點。不呼叫 `schedule()`、`trigger()`、`stop()`、`pause()`，
也不傳 `name` 選項——`name` 會把 job 登記進 croner module 級的 `scheduledJobs` 全域表。

排程本身仍然只做一件事：算出應該執行的 occurrence，然後 **enqueue**。實際執行由既有 worker 從佇列取出，
走 B04 的 occurrence fencing 與重試路徑。croner 不持有任何 timer，也不決定任何事情何時真的跑。

## 考慮過的選項

[B05 比較](../base/b05/cron-comparison.md) 實測了三個候選。cronosjs 在 spring-forward 把不存在的 02:30
對到轉換瞬間 03:00 而非欄位所指的 03:30，且沒有反向列舉 API（misfire 追補需要），排除。

cron-parser 與 croner 在測到的**每一個**案例逐毫秒相同，包含 Lord Howe 的 30 分鐘 DST、
Chatham 的 +12:45／+13:45、Tehran 廢除 DST 之後與 Kathmandu 的 +05:45。
兩者都從 runtime 的 `Intl` 取時區資料，所以 tz 更新跟著 Node 走。行為分不出高下，
於是 cron-parser 的 `luxon` 相依（實測 4.5M）成為唯一差別——它會進 [ADR 0007](0007-shared-artifact-deployment.md)
的單一部署 artifact，換不到任何測得出來的正確性。croner 零相依、164K。

**保留切片機制。** 否決：epoch 對齊的切片編號無法表達本地午夜，更無法在 DST 當天保持每天一次。

**在 croner 之上使用它自己的 scheduler。** 否決：那會讓「何時執行」分散到每個行程的記憶體裡，
與「排程只 enqueue、由同一 worker 執行」直接衝突，而且行程重啟就遺失狀態——正是 ADR 0016
當初否決自我續排時要避免的那種斷鏈。

## 後果

- 選了一個公開面比我們需要的大的套件。約束靠審查與下面的 falsification 條件維持，不靠套件本身。
  croner 若哪天把運算函式與 scheduler 綁得更緊，這個決策要重看。
- `previousRun()` 與 `previousRuns()` 語意不同：前者是該 Cron 實例的 runtime 狀態，
  對從未執行過的 job 回 `null`；只有後者是純運算。B05 探針實際踩到這一點，程式碼只能用後者。
- ADR 0016 的兩項已知限制由 B05 解除，但 0016 記的「不要有可以斷的鏈」這個理由**繼續有效**，
  並且是本決策要求 croner 不持 timer 的原因。0016 已標記為排程機制部分被本篇修訂。
- 時間運算與資料庫狀態分屬兩個檔案：`schedule-spec.ts` 是純函式（單元測試涵蓋 DST 與列舉），
  `recurring.ts` 負責 watermark、暫停與列鎖（真 PG 整合測試涵蓋）。croner 只被前者 import。
- 時區資料來自 runtime ICU。部署到裁減 ICU（small-icu）的 Node 會靜默算錯時區，
  這是新增的部署前提，屬 B15 的營運檢查範圍。

## Falsified if

`packages/platform/kernel/src/schedule-spec.ts` 或 `packages/platform/kernel/src/recurring.ts`
出現 croner 的 `schedule`／`trigger`／`stop`／`pause` 呼叫或 `name` 選項，代表排程開始持有 in-process timer 或全域註冊表；
或 `packages/platform/kernel/src/worker.ts` 不再是 occurrence 的唯一執行入口；
或 cron 運算改由另一個套件、或改回 `packages/platform/kernel/src/module.ts` 的 `everyMs` 切片為唯一機制
——任一成立，本篇的選型理由與約束都要重新檢視。
