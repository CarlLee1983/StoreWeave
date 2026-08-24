# 56 — Default Theme 顧客前台

**What to build:** 把已存在的 Theme DTO 與 Storefront 表單路由呈現為可在無 JavaScript 下
瀏覽、加車、登入與建立訂單的 Default Theme。這張票只做可由目前 DTO 證明的前台，
不新增付款、物流、運費、商品媒體或分類契約。

**Blocked by:** 14, 20, 29, 38, 49

**Status:** done

- [x] 共用 shell、商品／購物車／結帳、登入與會員頁都只渲染既有 Theme view，交易仍是 SSR 表單
- [x] 登入與購物車入口在頁首保持可取得；窄螢幕以單欄呈現，不要求 client-side menu
- [x] 商品與購物車數量只在 `available` 已知時輸出同一個前端上限；未知時不猜測數值
- [x] 字型由 Google Fonts CDN 以 unicode-range 分片提供，帶 `display=swap` 與 `preconnect`；
  取捨記在 `docs/adr/0026-storefront-fonts-from-google-cdn.md`
- [x] 正式 Theme 不載入任何第三方 script，也不載入遠端商品圖片

## 驗收

- Theme 單元測試涵蓋已知／未知庫存、已支援的訂單狀態、字型樣式表連結與置頂頁首。
- 跳脫測試對每個 render 出口注入攻擊字串，確認資料一律以文字輸出。
- `pnpm typecheck`、unit tests、build 與 release smoke 可在目前主幹上通過。

## 不做的事

- 不把付款方式、物流、地址規則、運費、商品媒體或分類假裝成已存在的資料。
- 不為了這張票拆分整個 renderer 或重做所有間距與圓角；那些是後續可獨立驗證的版面重構。
