# 98 — 認證版型拆成四個，系統頁清單只剩錯誤頁

**What to build:** Theme 作者不再需要為了通過啟動檢查而實作一個四模式的認證版型。登入、註冊、忘記密碼、重設密碼各自拿到只屬於它的資料形狀，而做一個純展示 Theme 的人根本不必寫登入表單——認證版型變成「有載入認證模組才要提供」的東西。

收尾票：前面每一張都讓新舊兩種形狀並存，這張把舊的收掉。

**Blocked by:** 95, 96, 97

**Status:** done

- [x] 四模式的聯集型別拆成四個各自獨立的 view 型別
- [x] 兩個 Theme 的 renderer 對照表跟著改；同一個渲染函式掛在 GET／POST 兩個鍵上（既有做法）
- [x] 登出宣告成不需要版型
- [x] `SYSTEM_PAGE_IDS` 移除 `platform.auth`，只剩錯誤頁
- [x] 沒有載入認證模組的 Theme 不再被要求提供認證版型；缺必需版型仍在啟動時被拒絕，訊息仍列出缺哪幾頁
- [x] controller 上的認證殘餘全部刪除
- [x] 表單轉義的既有案例覆蓋拆開後的四個版型
- [x] 登入失敗時保留使用者填的信箱（工單 94 留下來的：共用聯集沒有 email 欄位，拆開才做得到）

## 做完之後

[ADR 0047](../adr/0047-session-is-a-page-outcome.md) 的四條 falsification 條件全部成立，整合回歸通過後把它從 proposed 改成 accepted。**已完成**（2026-09-11）。

實作筆記：四個 view 型別由 `packages/platform/auth/src/pages.ts` 擁有，kernel 的 `theme.ts` 不再有任何認證形狀。`tests/integration/release-transition.test.ts` 那個 8→9 的 active owner 斷言是工單 97 加入 `platform-auth` 之後就失準的，一併補上。
