# 0024. Command / Query 的輸入一律拒絕未知欄位

- 狀態：accepted
- 日期：2026-08-23

## 背景

Zod 的 `z.object()` 預設會**丟掉**不認得的欄位：請求送了 `statuss: 'active'`，
schema 解析成功、handler 收到的物件裡沒有那個鍵，端點回 200，而使用者以為自己改到了狀態。
拼錯的欄位名、改版後被移除的欄位、送錯端點的整包 payload，三種情況的結果都一樣——
看起來成功，實際什麼都沒發生。

這個問題在這個 repo 裡原本有兩個答案。工單 10 的 `createPromotionInput`、
以及後來的 cart、coupon、loyalty 全部寫了 `.strict()`；catalog、inventory、customer、
order、promotion 剩下的 20 個 input，加上四支直接內嵌在註冊處的匿名 `z.object()`
與平台層的 identity、jobs，總共 28 支沒有。同一批 API 裡有些端點挑剔、有些不挑剔，
比兩者都寬鬆更糟：客戶端無從預期哪一個是哪一個。

## 決策

**Command Bus 與 Query Bus 上註冊的每一支輸入一律 `.strict()`**，未知欄位回
`VALIDATION_ERROR`（HTTP 400），範圍包含 commerce 八個模組與平台的 identity、jobs。
輸出 DTO 不受影響——那是回應的形狀，不是契約的入口。

**巢狀的輸入物件也算輸入**：訂單品項、試算品項、收件地址、活動規則都收緊了。
但其中兩支的 schema 同時是**讀回來**時走的那一支（`addressDto` 之於顧客資料、
`promotionRule` 之於 jsonb 裡的活動規則），因此另開了 `addressInput` 與
`promotionRuleInput`：只有寫入這一側嚴格。一起收緊會把「建立時被忽略的欄位」變成
「這筆資料從此讀不回來」——用一個看得見的錯誤換掉一個更嚴重的。

**Extension 的輸入暫時不在範圍內**（`ext.demo-erp.*` 三支）。
`apps/api/src/controllers/extensions.controller.ts` 的橋接把 query string 整包往下送，
先收緊會讓任何帶 `_t=` 這類 cache-buster 的呼叫立刻 400。要納入得先讓橋接明挑欄位，
那是獨立的一張票。

守在測試而不是守在慣例：`tests/unit/strict-inputs.test.ts` 從 `coreModules()` 走過
八個模組**註冊處**的每一支 descriptor，逐一斷言 `unknownKeys === 'strict'`。
新加的 command / query 忘記寫，那條測試會紅，不需要有人在審查時記得這件事。

掃註冊處而不是掃 `dto.ts` 裡叫做 `*Input` 的匯出，是因為有四支的輸入 schema 是直接
內嵌在 `defineQuery` / `defineCommand` 上的匿名 `z.object()`（catalog 的 getProduct、
customer 的 getMyProfile 與 getCustomer、order 的 expireOrder）。第一版的測試靠命名
慣例掃，這四支從頭到尾看不到——**判準要對齊真正的邊界，不是對齊命名習慣**。

斷言的是「真的解析一次會被擋」而不是 `_def.unknownKeys === 'strict'`：
`.strict().catchall(z.unknown())` 會讓那個欄位仍然是 `'strict'`，未知鍵卻照樣通過。
讀宣告驗不到行為。

`.refine()` 的順序是 `z.object({...}).strict().refine(...)`：`.refine()` 回傳的是
ZodEffects，在它之後才 `.strict()` 是接不上去的。

## 取捨

這會改變既有客戶端的行為：今天送了多餘欄位而被安靜忽略的請求，升級後會拿到 400。
接受這個代價的理由是——那些請求本來就沒有做到送出者以為它做到的事，400 只是把一個
沉默的失敗變成看得見的失敗。repo 內的呼叫端逐一追過，並且找到一個**當下就是壞的**：
`scripts/smoke.sh` 的下單請求還帶著工單 21 移除的 `customerEmail`，而且用服務 token
下單——那條路徑自工單 21 起就只接受顧客身分。release smoke 從流程二起就跑不完，
沒有人發現，因為沒有人在收緊之後重跑過它。已改成註冊一個顧客再用他的 session 下單。

MCP 那條路徑不是天生安全的。工具 schema 反而會**多**一個 `idempotencyKey`
（`packages/extensions/mcp/src/tools.ts`），目前四支工具都寫了 `mapInput` 明挑欄位才沒事；
下一支忘了寫就會把它送進下游的 strict schema 變成 runtime 才炸的 400。因此
`apps/api/src/mcp/mcp.controller.ts` 在沒有 `mapInput` 時會剝掉這個鍵。

**驗證失敗的 `details` 會回給呼叫端**（只有 `VALIDATION_ERROR` 這一種），
也一併寫進 `logger.warn`。沒有它，這個決策換來的是一個看不出要拿掉哪個鍵的 400，
等於把一種沉默換成另一種；`CONFLICT` 與 `INTERNAL_ERROR` 的 details 仍然只進 log。

沒有做「先記錄再拒絕」的過渡期。要記錄就得先有一版寬鬆解析、比對兩邊的差集、再擇期切換，
而這個專案還沒有外部客戶端的遙測可以看——過渡期只會換來一段誰都不會回頭讀的日誌。

## Falsified if

`tests/unit/strict-inputs.test.ts` 被改成只檢查部分模組、
或改回掃 `dto.ts` 的匯出而不是模組註冊處的 descriptor、
或它改回只讀 `_def.unknownKeys` 而不實際解析一次
（`.strict().catchall(z.unknown())` 會讓那個欄位仍是 `'strict'` 而未知鍵照樣通過）——
任一項成立，
代表「輸入的挑剔程度只有一個答案」這件事又鬆掉了，這篇記的理由要重新檢視。
