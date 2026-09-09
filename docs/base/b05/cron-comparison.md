# B05 cron／timezone 套件比較

日期：2026-09-08。基準：`b23658e`，分支 `b05-scheduler`。

[ADR 0035](../../adr/0035-retain-postgres-queue-for-modular-base.md) 已定「不以自製 cron parser 取代成熟套件」，
但沒有指定哪一個。[計畫 §1.3](../../base-implementation-plan.md#1-接手與派工方式) 要求涉及選型的包先完成指定比較，
主代理再決策。本文件就是那份比較，結論寫入 [ADR 0039](../../adr/0039-cron-calculation-only-croner.md)。

## 範圍與方法

隔離 package 位於 `scripts/poc/base-b05`，不屬於 pnpm workspace，未改根 manifest、lockfile 或 runtime。
探針只做純時間運算：不建資料庫、不啟動 timer、不呼叫 StoreWeave 任何程式碼。
Node v22.17.1（ICU 完整），三個候選為當日最新：`cron-parser@5.10.0`、`croner@10.0.1`、`cronosjs@1.7.1`。

四支探針：`probe.mjs`（基本時區、DST、列舉、prev）、`probe-prev.mjs`（反向列舉 API）、
`probe-syntax.mjs`（表達力與非法輸入）、`probe-odd-tz.mjs`（非整點位移與 30 分鐘 DST）。

只驗證「給定運算式、時區與一個注入的時間點，算出的 occurrence 序列」。
**沒有**驗證任何套件的 production 排程行為、多主機時鐘偏差，或與 B04 occurrence fencing 的整合。

## 行為結果

| 案例 | cron-parser | croner | cronosjs |
| --- | --- | --- | --- |
| Asia/Taipei `0 0 * * *` 午夜 | UTC 16:00 ✓ | 同 ✓ | 同 ✓ |
| NY spring-forward `30 2 * * *`（03-08 的 02:30 不存在） | 順延 03:30 | 順延 03:30 | **03:00** |
| NY fall-back `30 1 * * *`（01:30 出現兩次） | 只排一次（EDT） | 同 | 同 |
| 停機三天後由過去時間點列舉 | ✓ | ✓ | ✓ |
| `*/15 * * * *`（既有 everyMs 對應） | ✓ | ✓ | ✓ |
| Australia/Lord_Howe（30 分鐘 DST） | ✓ | 逐毫秒相同 | 未測 |
| Pacific/Chatham（+12:45／+13:45） | ✓ | 逐毫秒相同 | 未測 |
| Asia/Tehran（2022 廢除 DST） | ✓ | 逐毫秒相同 | 未測 |
| Asia/Kathmandu（+05:45） | ✓ | 逐毫秒相同 | 未測 |
| `1#1`／`L`／`5L`／6 欄含秒 | 全部支援 | 全部支援，結果相同 | 未測 |
| 非法欄位／欄數 | 兩者都 throw | 兩者都 throw | 未測 |
| 任意時間點的上一次應執行時間 | `prev()` 可連續回推 | `previousRuns(n, from)` 可；`previousRun()` 回 null | **無公開 API** |

cronosjs 在 spring-forward 給 03:00 而非 03:30——它把不存在的當地時間對到轉換瞬間，
不是順延到欄位所指的分鐘。加上沒有反向列舉（misfire 追補要用），先排除。

cron-parser 與 croner 在**每一個**測到的案例逐毫秒相同，含四個刁鑽時區。
兩者的時區來源都是 runtime 的 `Intl.DateTimeFormat`（croner 直接呼叫；cron-parser 經由 luxon），
所以 tz 資料跟著 Node 走，不需要等套件發版。行為上分不出高下。

## 非行為面

| | cron-parser 5.10.0 | croner 10.0.1 |
| --- | --- | --- |
| 相依 | `luxon ^3.7.2` | 無 |
| node_modules 實測 | 240K ＋ luxon 4.5M | 164K |
| API 形狀 | 只有運算（iterator，`currentDate` 注入） | 運算＋in-process scheduler（`schedule()`／`trigger()`／timer） |
| 反向列舉 | `prev()`，與 `next()` 對稱 | `previousRuns(n, from)` 純運算；`previousRun()` 是 runtime 狀態 |
| 已知踩點 | — | 傳 `name` 會登記進 module 級 `scheduledJobs` 全域表 |

## 決策

**croner，且只用它的運算函式。** 行為既然完全相同，剩下的就是相依面與部署體積：
croner 零相依、164K，cron-parser 要拖 4.5M 的 luxon 進 [ADR 0007](../../adr/0007-shared-artifact-deployment.md) 的單一 artifact，
換不到任何測得出來的正確性。

代價是 croner 的公開面同時是一個 in-process scheduler，而 B05 的契約是「排程只 enqueue，由同一 worker 執行」。
兩件事必須靠約束擋住，寫進 ADR 0039 的 falsification：只呼叫 `nextRuns`／`previousRuns`／`match`，
不呼叫 `schedule`／`trigger`／`stop`／`pause`，也不傳 `name`（避免 module 級全域註冊表）。
`previousRun()` 與 `previousRuns()` 語意不同，本次探針已實際踩到：前者對未執行過的 job 回 `null`，
只有後者是純運算。

## 保留的限制

- 探針全部單行程、單機、注入時鐘。多 worker 競爭、pause／misfire 持久化與 overlap 策略是 B05 實作與整合測試的事，
  本文件不宣稱已驗證。
- cronosjs 只跑了前五個案例即排除，其非整點時區與語法表現未測，不作結論。
- 這裡沒有測 croner 在 `Intl` 被裁掉的 runtime（small-icu）上的行為；StoreWeave 目前的 Node 是完整 ICU。
