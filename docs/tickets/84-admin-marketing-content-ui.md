# 84 — 遷移促銷、券、會員設定與品牌內容 UI

**GitHub:** [#21](https://github.com/CarlLee1983/StoreWeave/issues/21)

**What to build:** 把商品頁已驗證的互動元件沿用到四個編輯密集頁面，減少各頁抽屜和欄位外觀實作。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §2、§5

**Blocked by:** [Ticket 83 / #20](https://github.com/CarlLee1983/StoreWeave/issues/20)

**Status:** complete — independent Terra/high review PASS

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-terra / high`

## Ownership

PromotionsPage、CouponsPage、LoyaltyPage、BrandContentPage 及各自 tests、i18n 與已無引用的對應 CSS；不改其他頁與 Query。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/pages/PromotionsPage.tsx`
- `apps/admin/src/pages/CouponsPage.tsx`
- `apps/admin/src/pages/LoyaltyPage.tsx`
- `apps/admin/src/pages/BrandContentPage.tsx`
- `apps/admin/src/components/DateField.tsx`
- `apps/admin/src/components/DateTimeField.tsx`
- `docs/tickets/72-loyalty-settings-operations.md`
- `docs/tickets/78-admin-brand-content.md`

## Acceptance Criteria

- [x] 四頁的 table、toolbar、表單控制項、modal／drawer 與確認互動沿用 82／83 元件；無重複焦點、Esc 或 outside-click 實作。
- [x] 促銷規則不同欄位、百分比／基點換算、券開始／結束時間、公開碼／批次發放與會員門檻等原有語意維持；測試比對實際 API payload。
- [x] 品牌內容 kind 鎖定、區塊文字往返、圖片清單失敗提示、部分 PATCH、空更新阻擋與刪除確認仍成立。
- [x] DateField 保留 react-day-picker；DateTimeField 保留本地時間語意，必要 popup 改用既有 Popover primitive，不重寫日期演算法。
- [x] 失敗保留輸入、關閉不送出、提交有 busy 狀態；3 語 × 2 主題與 360px／1280px 能操作；長文欄位跨欄仍可閱讀。
- [x] 依頁移除無用 overlay／field 樣式，既有 validation 與 API client 不改；共享樣式仍有使用者時保留至其所屬票。

## Verification

pnpm typecheck:admin；pnpm test:admin；pnpm build:admin；四頁各一條主要編輯流程及日期 popup 的瀏覽器鍵盤檢查。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Implementation record (2026-09-06)

- Promotions、Coupons、Brand Content 的建立／編輯／發券及刪除確認，與 Loyalty 的等級移除確認，均改用 Ticket 82 的 Dialog；頁面不再自己監聽 Escape 或 backdrop click。Coupons 的列狀態動作也改用 RowMenu。
- 保留既有 api.* 呼叫、驗證、百分比／基點換算、部分 PATCH、null、`datetime-local` 本地時間與 react-day-picker。未新增 i18n key，既有三語字串足夠覆蓋元件的可讀名稱。
- Dialog 開啟時聚焦首欄；Promotions、Coupons、Loyalty、Brand Content 各有 Escape 關閉並回到實際 trigger 的 regression。Brand Content 已無使用者的 legacy `reason-dialog-*` CSS 已刪除；payload／drawer 樣式仍由 Shipping、ERP 和 Products 使用，因此保留。
- Follow-up review fixes: DateField now uses the Radix Popover primitive for Escape and outside dismissal, while retaining react-day-picker and local `YYYY-MM-DD` semantics. The official npm registry reports `@radix-ui/react-popover@1.1.23` peers React／react-dom `^16.8 || ^17.0 || ^18.0 || ^19.0`, with no Node or Vite peer; it works with this app's React 18.3, Node 22.17, and Vite 6 build, so no unrelated dependency was added. Brand Content covers RowMenu → Delete Dialog → Escape focus return; the four fixed tables now use scoped minimum widths so the existing `.table-wrap` scrolls instead of overlapping action controls.
- Passed: `pnpm typecheck:admin`; `pnpm test:admin`（21 suites／194 tests）；`pnpm build:admin`；`pnpm typecheck`；`pnpm test`（48 files／561 tests）；`git diff --check`。build 只有既有的 500 kB chunk warning。
- 隔離 fixture 的瀏覽器驗收通過：四頁主要編輯／確認流程、DateField popup 的鍵盤 Escape 回焦，以及 Promotions 的繁中、英文、日文 × 明暗主題 × 360px／1280px 矩陣；窄表格以水平捲動保持操作欄不重疊。未接觸真實商家或正式 API。
- Terra/high 首輪複核提出 DateField 手寫 dismissal、Brand Content 刪除回焦與窄表格問題，修正後要求補足 Radix provenance；`storeweave-84-final-doc` 最終 focused review PASS。剩餘風險：無；下一張為 Ticket 85。

## Out of Scope

React Hook Form 全面導入、富文本、媒體上傳、新增券或 loyalty 規則、查詢快取遷移。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
