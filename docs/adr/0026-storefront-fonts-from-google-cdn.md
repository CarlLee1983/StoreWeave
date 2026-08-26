# 0026. Storefront 字型由 Google Fonts CDN 提供

- 狀態：accepted
- 日期：2026-08-24
- 修訂（2026-08-26，ADR 0034）：「移除整套 Theme 靜態資產機制」的部分作廢；字型走 CDN 的決定不變

## 背景

Default Theme 的正文使用 Noto Sans TC。繁體中文字型無法像拉丁字型那樣「整包不到 100 KB」：
未做子集化的可變字重 WOFF2 是 **5.42 MB**，而商品名稱與描述可以是任意繁中內容，
不能靠猜測常用字集來砍。

工單 56 原本的做法是自託管：字型與 OFL notice 隨 release artifact 交付，
`StorefrontTheme.staticAssets` 宣告公開 prefix，API 掛載該 prefix，build 與 release
以 SHA-256 驗證。這個機制正確且有測試，但它讓每一位新訪客的第一個頁面付 5.42 MB。

實測 Google Fonts CSS API（2026-08-24）：Noto Sans TC 被切成 **105 個 unicode-range 分片**，
CSS 本身 121 KB，分片大小 8.9 KB 到 63 KB 不等。一般繁中頁面只命中其中幾個，
實際字型流量約在 30–150 KB——比自託管整包少兩個數量級。

## 決策

Storefront 的字型改由 `fonts.googleapis.com` 提供，並移除整套 Theme 靜態資產機制：
`StorefrontTheme.staticAssets` 契約、`apps/api` 的靜態掛載與 `resolveThemeAssetsDir`、
`scripts/theme-assets.mjs` 的雜湊清單、build 與 release 的複製與驗證，全部刪除。
這些程式碼只為了送字型而存在，改走 CDN 之後沒有其他使用者；依專案「不預先抽象」的規則，
留著零使用者的基礎建設比刪掉它更貴。

同樣的網路效果其實可以自己做——那 105 個分片就是 `pyftsubset` 按 unicode-range 切出來的，
不是 Google 的專利。這裡選擇不自己做，換來的是不必維護分片管線、產生 CSS 與上百個檔案的
雜湊清單。

**這是一個明確的隱私取捨，不是疏忽。** 顧客的 IP、User-Agent 與 Referer 會在每次瀏覽時
送到 Google，包含購物車與結帳這些帶 session 的頁面。2022 年 LG München I 的判決認定
未經同意嵌入 Google Fonts 違反 GDPR，就是這個模式。專案在知情的情況下接受它。

第三方 **script** 的立場沒有變：Theme 仍然不輸出任何 `<script>`，交易全部是 SSR 表單。

## 後果

- 面向歐盟顧客的部署需要自行處理同意機制，或改回自託管。這個決定不適合直接套用到那種場景。
- `fonts.googleapis.com` 在中國大陸被封鎖；該地區訪客會落到 `--font-sans` 的系統字型 fallback。
  版面不會壞，但字形會不同。
- 字型進入關鍵路徑的第三方 origin：先解析 DNS、建 TLS、取 CSS，才知道要抓哪些分片。
  `<link rel="preconnect">` 已經加上，用來省掉其中一段來回。
- 專案目前**沒有設定 CSP**。之後若要加，`style-src` 必須包含 `fonts.googleapis.com`、
  `font-src` 必須包含 `fonts.gstatic.com`。
- ~~Release artifact 不再包含任何 Theme 靜態資產，離線／內網部署的 Storefront 會退到系統字型。~~
  ADR 0034 之後這句只對字型成立：release 仍帶編輯照片，`/storefront-assets/` 照常服務。

## Falsified if

`packages/themes/default/src/layout.ts` 不再引用 `fonts.googleapis.com`，
或 `StorefrontTheme`（`packages/platform/kernel/src/theme.ts`）重新出現靜態資產宣告——
兩者都代表字型交付回到同源，這份決定連同它的隱私取捨需要重新檢視。
