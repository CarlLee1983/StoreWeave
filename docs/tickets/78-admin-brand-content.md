# 78 — 後台品牌內容管理

**What to build:** content 模組的 CRUD 有了，後台沒有入口。新增
`apps/admin/src/pages/BrandContentPage.tsx`：清單（依 kind 與 status 篩選）、建立抽屜、
編輯抽屜，草稿與發布狀態切換照 `PromotionsPage` 的做法，雙抽屜共用欄位元件照 `ShippingPage`。
在 `apps/admin/src/routes.tsx` 的 `ENTRIES` 加一列（section `commerce`），
`apps/admin/src/api.ts` 加型別與方法，`apps/admin/src/i18n.tsx` 三語系補字串。

**Blocked by:** 76

**Status:** completed

- [x] 內文以單一 textarea 編輯：空行分段，一段以 `## ` 開頭時那一行是該區塊的標題；
      `bodyToText` / `textToBody` 是純函式，往返有測試（有標題／無標題／混合三種）
- [x] 配圖是下拉選單，選項打 `GET /api/v1/content/articles/image-keys` 取得，不在前端寫死——
      合法 key 屬於 Theme（ADR 0034），寫死等於複製一份會漂移的清單
- [x] `kind` 建立後不可更改，編輯抽屜的該欄位 disabled
- [x] 刪除走頁面層級的確認對話框，不用 `window.confirm`
- [x] 編輯只送真正改過的欄位，全部沒變時擋下並提示。`updateArticleInput` 的
      `refine` 本意是「空 patch 不寫稽核」，整包送出會讓它永遠成立
- [x] 圖片清單載入失敗時把錯誤顯示出來，不是靜靜只剩「不配圖」
- [x] 內文 textarea 在 `.form-grid` 裡跨兩欄——原本用了 `enhancements.css` 裡不存在的
      `form-field--full`，整頁最重要的欄位被擠在半欄
- [x] jsdom 測試覆蓋清單篩選、建立與驗證錯誤、kind 鎖定、發布與下架、刪除對話框、
      不改欄位的擋下與只送差異

## 不做的事

- 媒體上傳（ADR 0034 已記）；富文本編輯器；預覽。
