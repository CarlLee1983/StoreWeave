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
order、promotion、loyalty 剩下的 20 個 input 沒有。同一批 API 裡有些端點挑剔、有些不挑剔，
比兩者都寬鬆更糟：客戶端無從預期哪一個是哪一個。

## 決策

**所有 Command 與 Query 的 input schema 一律 `.strict()`**，未知欄位回
`VALIDATION_ERROR`（HTTP 400）。輸出 DTO 不受影響——那是回應的形狀，不是契約的入口。

守在測試而不是守在慣例：`tests/unit/strict-inputs.test.ts` 從 `coreModules()` 走過
八個模組**註冊處**的每一支 descriptor，逐一斷言 `unknownKeys === 'strict'`。
新加的 command / query 忘記寫，那條測試會紅，不需要有人在審查時記得這件事。

掃註冊處而不是掃 `dto.ts` 裡叫做 `*Input` 的匯出，是因為有四支的輸入 schema 是直接
內嵌在 `defineQuery` / `defineCommand` 上的匿名 `z.object()`（catalog 的 getProduct、
customer 的 getMyProfile 與 getCustomer、order 的 expireOrder）。第一版的測試靠命名
慣例掃，這四支從頭到尾看不到——**判準要對齊真正的邊界，不是對齊命名習慣**。

`.refine()` 的順序是 `z.object({...}).strict().refine(...)`：`.refine()` 回傳的是
ZodEffects，在它之後才 `.strict()` 是接不上去的。

## 取捨

這會改變既有客戶端的行為：今天送了多餘欄位而被安靜忽略的請求，升級後會拿到 400。
接受這個代價的理由是——那些請求本來就沒有做到送出者以為它做到的事，400 只是把一個
沉默的失敗變成看得見的失敗。repo 內的呼叫端（控制器、前台、週期性工作、MCP、demo-erp）
都已經確認沒有送多餘欄位；MCP 那條路徑另外有一層保護：它先用自己的工具 schema 解析，
Zod 預設會把未知欄位剝掉，因此傳到 Command Bus 的物件只有認得的鍵。

沒有做「先記錄再拒絕」的過渡期。要記錄就得先有一版寬鬆解析、比對兩邊的差集、再擇期切換，
而這個專案還沒有外部客戶端的遙測可以看——過渡期只會換來一段誰都不會回頭讀的日誌。

## Falsified if

`tests/unit/strict-inputs.test.ts` 被改成只檢查部分模組、
或改回掃 `dto.ts` 的匯出而不是 `coreModules()` 的 descriptor、
或它的數量下限被調低到掃不到東西也能通過 —— 任一項成立，
代表「輸入的挑剔程度只有一個答案」這件事又鬆掉了，這篇記的理由要重新檢視。
