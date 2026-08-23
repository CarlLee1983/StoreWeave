# 55 — Bus 計時的整合測試會被機器忙碌搞紅，也會被搞綠

**What to build:** `tests/integration/bus-timing.test.ts` 的斷言不要建立在「這次呼叫一定夠快」上。範圍只有這支測試與它需要的最小改動；`logBusCall` 的 level 表是工單 53 拍板過的，不在這一票重開。

**Blocked by:** —

**Status:** open

- [ ] 六處以 `msg` 精確比對的過濾不再假設快路徑（工單 53 的 level 表照舊）
- [ ] 「成功那一行不該出現」那條改成連 `slow ` 那個變體也擋得住——它現在會假綠
- [ ] 拍板 level 斷言留在哪一層（下方「要決定的事」）
- [ ] 連跑數次或在機器忙碌時仍然穩定

## 這是什麼問題

`logBusCall`（`packages/platform/contracts/src/timing.ts:52-59`）在 `latencyMs >= SLOW_CALL_MS`（500）時
把訊息換掉，而不是多加一個欄位：

```ts
const slow = outcome.latencyMs >= SLOW_CALL_MS;
if (slow) logger.warn(fields, `slow ${message}`);
else if (kind === 'command') logger.info(fields, message);
else logger.debug(fields, message);
```

整合測試那一端全部是精確比對：

```ts
const executed = lines.filter((l) => l.fields.command === '…' && l.msg === 'command executed');
expect(executed).toHaveLength(1);
expect(executed[0].level).toBe('info');
```

機器一忙，`createProduct` 超過 500ms，那一行就變成 `slow command executed` 走 `warn`，
過濾器整個撈不到東西，斷言收到的正是 `expected [] to have a length of 1 but got +0`。
`msg` 與 `level` 兩個條件同時失效，所以只放寬其中一個沒有用。

**這就是交接文件裡那筆「至今沒有解釋」的 `test:all` 失敗。**
2026-08-23 在工單 54 的分支上連跑四輪 `test:all`：前兩輪全綠（850、858），
後兩輪各紅 2 筆與 4 筆，`bus-timing` 這條兩輪都在裡面，逐檔單獨重跑都綠。
同一批還紅過 `cart-hardening` 的節流與 `boundaries` 的逾時——那兩支是另一種形狀，
不在這一票。

## 比紅更糟的那一條：它會假綠

`tests/integration/bus-timing.test.ts:110`：

```ts
// 成功那一行不該同時出現——交易回滾了，這次呼叫只有一個結局。
expect(lines.filter((l) => l.msg === 'command executed')).toEqual([]);
```

這條要證的是「失敗的呼叫不會同時留下成功那一行」。但如果哪天真的兩行都寫出來、
而那次呼叫剛好慢，成功那一行叫 `slow command executed`，過濾器一樣是空的，**測試照樣綠**。
它在最該攔到迴歸的情況下失效。上面那五處是會吵的假紅，這一處是不會吵的假綠。

## 要決定的事

`msg` 帶 `slow ` 前綴是**刻意的**：`docs/operations.md` 的「要知道哪一支慢」教的撈法就是
`grep '"msg":"slow '`。所以解法不該是把訊息改成固定字串、把快慢移到欄位上——
那會把一份已經寫進維運文件的介面換掉。

真正要拍板的是**level 斷言留在哪一層**。目前它被驗了兩次：

| | 控制得了耗時嗎 | 驗了什麼 |
| --- | --- | --- |
| `packages/platform/contracts/test/timing.test.ts` | 是（直接餵 `latencyMs`） | 完整的 level 表，快慢兩側都有 |
| `tests/integration/bus-timing.test.ts` | **否**（真的跑一次 Command） | 同一張表的快路徑那一格 |

整合測試控制不了耗時，卻在斷言一個由耗時決定的值——這是它唯一會 flake 的原因，
而它驗的那一格單元測試已經完整涵蓋了。傾向的做法是**整合測試不再斷言 level**，
改成比對 `msg` 的兩種變體（或以 `endsWith('command executed')` 之類的方式），
專心驗它真正獨有的東西：那一行真的有 `latencyMs`、有 `owner`／`correlationId`／
`replayed`／`code`，而且失敗與成功不會同時出現。

**不要為了測試把 `SLOW_CALL_MS` 開成設定。** 工單 53 明確拍板它是常數
（「沒有任何一座部署提過不同的數字」），為了讓測試好寫而開成設定是拿產品的介面
換測試的方便。真的需要注入門檻的話，該注入的對象是 `logBusCall` 的參數而不是全域設定，
而在採用上一段的做法之後就不需要了。

## 這張票不做的事

- 不動 `logBusCall` 的 level 表與訊息格式（工單 53 拍板、`docs/operations.md` 依賴）。
- 不處理 `cart-hardening` 與 `boundaries` 那兩支的逾時，那是機器負載下的另一種形狀。
- 不加重試或 `retry` 設定——那會把這條測試變成「多跑幾次就會過」，
  假綠那一項反而更難發現。
