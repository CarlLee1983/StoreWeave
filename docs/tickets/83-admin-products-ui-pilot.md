# 83 — 以商品頁完成 shadcn UI 垂直試點

**GitHub:** [#20](https://github.com/CarlLee1983/StoreWeave/issues/20)

**What to build:** 商品清單、建立、編輯與庫存調整使用同一組新 primitives，驗證完整操作後再推廣其他頁。這張票只遷移互動與呈現，資料 Query 留給 87。

**Spec:** [Spec 0008](../specs/0008-admin-foundations-and-contracts.md) — Spec 0008 §2、§5

**Blocked by:** [Ticket 82 / #19](https://github.com/CarlLee1983/StoreWeave/issues/19)

**Status:** complete (independent Terra/high review PASS)

**Execution:** `gpt-5.6-terra / high`，使用者逐一派工；本票不設定 GitHub assignee。

**Independent review:** `gpt-5.6-terra / high`

## Ownership

ProductsPage、ProductsPage.test.tsx、該頁使用的 UI primitives 與 CSS；i18n 中受影響字串、DESIGN.md 的商品頁實例。

同一語意切片只有一位 writer；開始前檢查 git status，保留其他人的未提交修改。
先讀相依工單的完成結果與共用元件，再修改本票範圍；共用檔案以本票行為所需最小差異更新。

## Read first

- `apps/admin/src/pages/ProductsPage.tsx`
- `apps/admin/src/pages/ProductsPage.test.tsx`
- `apps/admin/src/routes.tsx`
- `apps/admin/src/api.ts`
- `docs/adr/0032-product-status-transitions-are-not-enforced.md`

## Acceptance Criteria

- [x] 清單 toolbar、原生 Table、分頁、row actions 與 create／edit／stock Sheet 使用 82 primitives；未新增後端未支援的排序或全資料載入。
- [x] 名稱／描述／售價／庫存調整的 api.*、整數驗證、部分 PATCH、空更新阻擋、null 語意與具名狀態動作維持。
- [x] 頁首建立動作仍可開啟表單；錯誤保留在對應表單，取消不送出，提交中不重複執行，關閉焦點返回觸發者。
- [x] 總數與當頁狀態計數清楚區分；維持現有本頁庫存批次查詢，未退化成逐列請求。
- [x] 改動文案重用既有三語 key；雙主題與窄版無遮擋主要操作；保留現有 24 個商品測試的行為覆蓋並補鍵盤 regression。
- [x] 該頁舊 overlay／drawer 互動與專屬無用 CSS 下線；列出 84–86 可直接沿用的 primitives，未建立萬用 CRUD component。

## Verification

pnpm typecheck:admin；pnpm test:admin；pnpm build:admin；商品建立→編輯→狀態變更→庫存調整的本機瀏覽器驗證。

遵守 Spec 0008 的共用驗證規範；交付附實際通過／失敗／未跑項目與原因、受影響檔案及風險。
視覺與焦點驗收不能只用 jsdom 代替。既有無關失敗需附基準證據，不能靜默略過。

## Out of Scope

TanStack Query、React Hook Form、TanStack Table、自訂欄位 schema、批次編輯、商品 domain 改造。

## Implementation record

- `ProductsPage` 的建立／編輯 Sheet 與庫存調整 Dialog 改用 82 的 `Dialog`；由 primitive 處理 Escape、dismiss 與 focus trap，頁面只指定首欄聚焦及回到實際觸發按鈕。RowMenu 維持 82 primitive。
- 保留既有 native table、toolbar、分頁及批次庫存讀取；窄版只補 `.products-table { min-width: 760px }`，交給既有 `.table-wrap` 水平捲動，未增加 Table 或 CRUD 抽象。
- 移除商品專屬的 overlay／drawer／Esc 路徑；共用 legacy payload drawer 仍有其他頁消費者，未越票刪除。原有 API、validation、partial PATCH/null、named status actions 未改。
- `ProductsPage.test.tsx` 的既有 Esc 案例改成鍵盤開啟後驗證回焦，保留本頁 24 個行為測試。
- 可供 84–86 直接沿用：`Dialog`、`DialogClose`、`DialogContent`、`DialogTitle`、`RowMenu` 與 `DropdownMenu`；各頁自行提供表單 Sheet 的語意 class，不建立萬用元件。

## Verification record

- Passed: `pnpm typecheck:admin`; `pnpm test:admin`（21 suites／189 tests）；`pnpm build:admin`; `git diff --check`。
- Passed: 使用隔離本機 fixture 完成建立→編輯→狀態變更→庫存調整；建立／編輯／庫存 Dialog 的首欄聚焦、Escape 與回焦均以實際瀏覽器檢查。
- Passed: 瀏覽器 Products 頁三語 × 明暗主題 × `360×800`／`1280×800`；窄版以可水平捲動表格避免欄位與操作重疊。
- Passed: 最終 build 再以實際瀏覽器驗證 RowMenu → 庫存 Dialog → Escape，焦點回到 `更多操作` trigger。
- Passed: Terra/high 獨立複核。首輪指出 RowMenu action 的回焦目標與殘留 `h3` CSS；修正後複核 PASS，並確認其他 RowMenu 消費者的零參數 callback 相容。
- Not run: 對真實商家或正式 API 的測試（本票未授權，且不需要）。

## Rollback

本票維持可單獨審查的變更；依 Spec 0008 逆相依回退，無 DB migration。依賴本票的後續變更存在時不得只回退 foundation。
