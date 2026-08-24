# 56 — Default Theme 顧客前台與同源資產交付

**What to build:** 把已存在的 Theme DTO 與 Storefront 表單路由呈現為可在無 JavaScript 下
瀏覽、加車、登入與建立訂單的 Default Theme；Noto 字型與其授權必須隨 release 以同源靜態
資產交付。這張票只做可由目前 DTO 證明的前台，不新增付款、物流、運費、商品媒體或分類契約。

**Blocked by:** 14, 20, 29, 38, 49

**Status:** done

- [x] 共用 shell、商品／購物車／結帳、登入與會員頁都只渲染既有 Theme view，交易仍是 SSR 表單
- [x] 登入與購物車入口在頁首保持可取得；窄螢幕以單欄呈現，不要求 client-side menu
- [x] 商品與購物車數量只在 `available` 已知時輸出同一個前端上限；未知時不猜測數值
- [x] Default Theme 宣告 `/theme/default/` 靜態 prefix；API 掛載宣告的 Theme 資產而非特判 Theme id
- [x] release 複製、雜湊驗證並封裝兩份 Noto WOFF2 與各自的官方 OFL notice；來源記在
  `packages/themes/default/assets/fonts/SOURCE.md`
- [x] 本機開發顯式以 `COMMERCE_THEME_ASSETS_DIR` 指向 source assets；release 缺少已宣告資產會在啟動時失敗
- [x] 原型只作為設計探索，未併入產品分支；正式 Theme 不載入 Google Fonts 或遠端商品圖片

## 驗收

- Theme 單元測試涵蓋已知／未知庫存、已支援的訂單狀態、同源字型 URL 與置頂頁首。
- 資產測試驗證來源、build output 與 release 清單；任一字型或授權檔遭竄改都會失敗。
- `pnpm typecheck`、unit tests、build 與 release smoke 可在目前主幹上通過。

## 不做的事

- 不把付款方式、物流、地址規則、運費、商品媒體或分類假裝成已存在的資料。
- 不為了這張票拆分整個 renderer 或重做所有間距與圓角；那些是後續可獨立驗證的版面重構。
