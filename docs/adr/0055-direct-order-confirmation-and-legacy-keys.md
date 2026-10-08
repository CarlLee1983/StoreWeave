# 0055. 直接下單的確認與舊識別鍵

- 狀態：accepted
- 日期：2026-10-08

Issue #125 選擇保留顧客直接下單並補齊契約。它是不用 Cart 的宅配購買入口：必須確認商品單價、商家配送方式、完整地址與運費；與購物車共用 Order 建立、鎖定和拒絕邊界。超商選店權杖綁定 Cart，直接下單不接受原始門市資料。新請求以 Actor 隔離識別鍵，除首次成立使用的運費確認外，完整交易輸入參與比對；運費確認與購物車一樣不納入重送 hash，明細順序保留定價分攤的順序語意。這修訂 ADR 0054 對直接下單的範圍；不新增 MCP 下單工具。

舊的直接訂單沒有配送快照，也沒有 Cart 訂單連結可防止重複建立。Command Bus 提供明確 opt-in 的舊鍵拒絕 policy，在新範圍宣告前讀取舊 `(command, key)` 列，先比對 Actor，再比對舊輸入 hash 與狀態。另一顧客的舊列不影響新範圍。自己的歷史成功鍵回傳帶原訂單識別的 `legacy_order_exists` validation refusal，不建立第二張訂單，也不宣稱新地址已套用。Order 提供舊輸入投影與安全拒絕；Platform 不認識訂單。既有列沒有 TTL，因此這個 guard 隨歷史列保留。

舊輸入不含確認與配送欄位，升級後會 validation 拒絕。呼叫端須升級，未知結果先依原鍵嘗試或查詢原訂單，不得自動換鍵。部署前停止並 drain 舊 API／Command writers，再一起升級；不能讓舊全域鍵與新範圍 writers 混跑。回滾必須先凍結寫入或使用能看見兩種範圍的相容版本，不能直接回到不認識新鍵的舊 writer。保留所有識別鍵與訂單，不需要 schema migration。

## Falsified if

`packages/commerce/order/src/dto.ts` 接受未驗證的 pickup 門市，`packages/commerce/order/src/commands.ts` 建立另一條 Order 寫入流程，或 `packages/platform/command-bus/src/command-bus.ts` 在確認舊鍵 Actor 前洩漏 hash／response，任一條成立即重新評估。
