# Woven Day storefront prototype

這是一次性 UI 原型，不是產品程式碼。它回答的問題是：**「織日選物的首頁應以哪一種資訊層級與版型進入正式前台設計？」**

在 repository 根目錄執行：

```bash
pnpm prototype:storefront
```

開啟 `http://127.0.0.1:5173`，或直接使用：

- `?variant=editorial` — 故事導向的產品入口
- `?variant=catalog` — 商品清單優先的入口
- `?variant=atelier` — 情境拼貼導向的入口

頁面底部的控制列可以切換版本；左右方向鍵也可切換（焦點位於輸入欄位時不會攔截按鍵）。所有加入購物車、搜尋與分類動作都只改變記憶體中的原型狀態。

## 字型與正式交付

這個本機原型直接載入 Google Fonts CSS API，使用 Noto Sans TC（400、500、600、700）與 Noto Serif TC（400、500、600），並採用 display=swap。這是為了快速檢視中文排版的原型便利性，不是正式頁面的網路依賴。

正式 Theme 的字型、色彩、可近用與交易呈現規則，以 [Default Theme 顧客前台設計規格](../DESIGN.md) 為準。正式環境必須把經確認的 Google Fonts WOFF2 字型檔隨靜態資產發布，不能在帶有帳戶或購物車 session 的頁面載入 Google CDN。

## 真實交易的接入界線

原型中的商品名稱、價格、圖片、搜尋與加入購物車都只是記憶體中的示範狀態，不能接到正式環境。選定方向後，正式首頁與商品頁必須只渲染現有 ThemeProductView 資料：

- 商品卡連到 GET /p/:id；沒有真實媒體介面前，不展示原型圖。
- 商品詳情以 POST /cart/items 表單送出 productId 與 quantity；有 session 時才輸出 Context 提供的 CSRF token，訪客 guest cart 沿用既有同源寫入檢查。
- 購物車與結帳使用既有 SSR POST 表單、目前重新計算的 Cart view、登入要求與伺服器端 cartId 冪等規則。
- 訂單成功與付款狀態以 server 提供的 order view 為準，不由按鈕或前端記憶體推論。

完整約束與未來資料介面擴充方式見 [Default Theme 顧客前台設計規格](../DESIGN.md)。

## 圖片來源

原型使用 Unsplash 的遠端圖片，不會收進 repository。圖片在原型頁尾提供來源：

- Kam Idris — neutral interior
- Spacejoy — living room
- Sidekix Media — bedroom interior

依 [Unsplash License](https://unsplash.com/license)，標準 Unsplash 圖片可免費用於商業與非商業用途；本原型仍保留署名。實際產品上線前仍須逐張確認該圖片沒有商標、可識別人物或受保護的藝術作品。

## 清理方式

選定方向後，將選中的設計原則重新實作進 Theme；此資料夾與 `prototype:storefront` script 都只留在這個原型分支，不併入產品分支。
