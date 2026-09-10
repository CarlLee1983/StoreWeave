# StoreWeave 完整 Demo 操作指南

本指南提供如何快速啟動環境、一鍵注入全真品牌示範數據（Seed Data），並引導您在向團隊、客戶或利害關係人演示時，完整展現 **「織日選物／Woven Day」品牌旗艦門面** 與 **StoreWeave 後台管理系統** 的所有核心亮點。

---

## 🚀 1. 快速啟動與注入 Seed 數據

### 步驟 A: 啟動資料庫與開發環境
```bash
# 啟動 PostgreSQL (可透過 Docker 或既有資料庫)
docker compose up -d postgres

# 或在本機開發環境設定環境變數
export DATABASE_URL=postgres://commerce:commerce-dev-password@127.0.0.1:5432/commerce
export COMMERCE_SIGNING_KEY_K1=$(openssl rand -base64 32)
export COMMERCE_CONFIG=deployments/example-store/commerce.yaml
# API token 由 CLI 簽發，秘密只顯示一次：
#   pnpm commerce token:create --name demo --role admin
```

### 步驟 B: 一鍵注入 Demo 數據
```bash
pnpm seed -- --demo
```

### 步驟 C: 啟動 API 與 Worker
```bash
# 終端機 1：啟動 API 伺服器
pnpm dev:api

# 終端機 2：啟動背景工作 Worker (負責 Outbox 投遞與 ERP 佇列)
pnpm dev:worker
```

訪問站點：
* **前台品牌旗艦店**：[http://localhost:3000](http://localhost:3000)
* **後台管理系統**：[http://localhost:3000/admin](http://localhost:3000/admin)

---

## 🔑 2. 示範帳號矩陣（Demo Credentials）

Seed 腳本已預先建立好不同角色的完整 Persona：

| 角色 | 登入 Email | 密碼 | 特色與展示重點 |
| :--- | :--- | :--- | :--- |
| **後台管理員** | `admin@storeweave.test` | `AdminPassword123!` | 擁有完整後台權限（商品、訂單、RMA、發票、ERP 佇列、系統健康度）。 |
| **金卡 VIP 會員** | `gold_vip@woven-day.test` | `CustomerPassword123!` | 擁有 **$650 購物金**、**8,500 點積分（金卡會員 1.5x 回饋）**，可演示購物金折抵與會員中心儀表板。 |
| **一般會員** | `alice@example.com` | `CustomerPassword123!` | 基礎等級會員，可用於演示前台登入、購物與首購領券流程。 |

---

## 🎨 3. 前台「織日選物」品牌體驗導覽

前台的品牌內容全部來自 Core 的 content 模組（ADR 0033），不是寫死在 Theme 裡。
導覽列只會出現「已經有發布內容」的入口——空資料庫的商店看不到品牌故事與生活誌，
這是刻意的，不是壞掉。

### A. 首頁 `/`

由上而下實際渲染的區塊（`packages/themes/default/src/index.ts` 的 `renderHome`）：

1. **Hero**：標題與導言取自已發布的品牌故事，沒有發布故事時退回通用文案。
   右側是 Theme 隨附的編輯照片，單一行動按鈕「瀏覽商品」。
2. **品牌區塊**：品牌故事的摘要與三個章節，連向 `/story`。
3. **最新消息**：最新三則公告的日期式清單，連向 `/news`。
4. **正在販售的商品**：**六張**精選卡；完整的 24 款要到 `/catalog`。
   `WD-POT-07` 是售罄狀態的示範。
5. **選物導引**：連向型錄，說明搜尋與價格區間可用。
6. **生活誌**：最新兩篇文章卡片，連向 `/journal`。
7. **購物流程三步**：瀏覽、加入購物車、核對結帳。

### B. 商品型錄 `/catalog`

24 款商品的完整清單，支援名稱／SKU 搜尋與價格區間篩選，含分頁。
首頁與型錄是兩個不同的頁面，別把首頁的六張卡當成全部商品。

### C. 品牌內容四頁

| 路徑 | 內容 | seed 注入 |
| --- | --- | --- |
| `/story` | 品牌故事一頁式，含三個具名章節與隨附照片 | 1 篇 |
| `/journal`、`/journal/:slug` | 生活誌清單與閱讀頁，照片式卡片版型 | 3 篇 |
| `/news`、`/news/:slug` | 最新消息，日期式清單版型 | 2 則 |
| `/faq` | 常見問題，依店家自訂的分類分組 | 4 則（出貨與配送／退換貨／會員與購物金） |

未發布或不存在的 slug 一律 404，不會退回首頁。

### D. 聯絡我們 `/contact`

SSR 標準表單，沒有 JavaScript 也送得出去。匿名訪客可以送；登入的顧客送出時，
訊息會連到他的顧客身分，後台看得到是誰問的。表單有隱藏的防機器人欄位，
填了它會拿到一般的成功畫面但訊息不落表——這是刻意的，讓機器人分不出差別。

**這一輪不寄信**：訊息落表後由後台收件匣處理，理由見工單 79。

### E. 值得走一次的完整動線

1. 後台 `/admin/brand-content` 新增一則最新消息，先存草稿——前台 `/news` 看不到它。
2. 按下發布，重新整理 `/news`，那一則立刻出現。
3. 前台 `/contact` 送出一則訊息。
4. 後台 `/admin/contact-inbox` 看到它，展開讀內容，標記已處理。

這條動線示範的是這一輪的核心：品牌內容從「改程式碼才能改」變成「店家自己維護」。

---

## 🛍️ 4. 購物流程與行銷活動示範

### A. 折扣碼與行銷碼測試
在購物車結帳時，可嘗試輸入以下代碼：

| 折扣碼 | 類型 | 優惠條件 | 備註 |
| :--- | :--- | :--- | :--- |
| `WELCOME100` | 公開共用碼 | 滿 $500 現折 $100 | 每個會員帳號限用一次 |
| `WOVEN2026` | 季節折扣碼 | 滿 $500 現折 $100 | 季節慶典專用碼 |
| `LIFESTYLE_CARL` | KOL 行銷碼 | 滿 $1,500 現折 $200 | 帶合作夥伴 `CARL_STYLE` 歸因追蹤 |

### B. 自動促銷疊加與免運門檻
* **滿額現折**：購物車商品小計滿 $2,000，系統自動折抵 $200。
* **免運優惠**：
  * 選擇 **黑貓宅急便宅配** 滿 $1,500 即享免運。
  * 選擇 **7-ELEVEN / 全家超商取貨** 滿 $1,000 即享免運。
* **購物金折抵**：以 `gold_vip@woven-day.test` 登入，可在購物車直接折抵最高 $650 購物金！

---

## ⚙️ 5. 後台管理系統（Admin Portal）展示重點

以 `admin@storeweave.test`（密碼 `AdminPassword123!`）登入後台：

1. **訂單管理（/orders）**：
   * 查看即時交易流、訂單明細、付款狀態與 ERP 投遞結果。
2. **商品與庫存管理（/products）**：
   * 查看 24 件商品目錄、編輯商品售價、上架/下架/封存狀態。
   * 調整商品庫存（可用 / 保留 / 現有庫存），並記錄調整原因。
3. **配送與物流（/shipping）**：
   * 查看 4 種配送方式與免運門檻設定。
4. **促銷活動與優惠券（/promotions & /coupons）**：
   * 檢視滿額折、整單折扣規則與啟用狀態。
   * 檢視優惠券領取與使用次數，包含 KOL 合作夥伴行銷碼成效。
5. **會員管理（/customers）**：
   * 檢視金卡 VIP 與一般會員資料、訂單歷史。
   * 演示生日修正（保留審計原因記錄）與手動調整購物金/等級積分。
6. **購物金與等級設定（/loyalty）**：
   * 檢視 4 階會員等級（一般會員、銀卡、金卡、黑卡 VIP）倍率與購物金回饋百分比。
7. **ERP 投遞與死信佇列（/erp & /dlq）**：
   * 檢視交易事件的 JSON Payload 預覽與手動重送功能。
8. **系統健康度與 MCP（/system）**：
   * 檢查資料庫、Worker 與已安裝 Extension 狀態。
   * 檢視公開的 MCP AI 工具列表（`search_products` / `get_order` / `adjust_inventory` 等）。
