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
export COMMERCE_ADMIN_TOKEN=dev-admin-token-change-me-please
export COMMERCE_MCP_TOKEN=dev-mcp-token-change-me-please
export COMMERCE_CONFIG=deployments/example-store/commerce.yaml
```

### 步驟 B: 一鍵注入 Demo 數據
```bash
pnpm seed
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

### A. 生活風格首頁提案
1. **頂部促銷跑馬燈（Announcement Bar）**：
   * 醒目的磚紅公告列：`全站消費滿額享免運 ｜ 新會員加入現領專屬購物金 ｜ 7 日安心鑑賞保障`。
2. **生活風格 Hero Banner**：
   * 大標題：*「日日相伴的器物與織物，讓生活回歸本質。」*
   * 雙行動導流按鈕（探索選品 / 了解工藝）。
3. **品牌四大承諾（Brand Pillars）**：
   * 🌿 **天然與手作質地**、📦 **全站滿額免運**、🕊️ **7 日安心鑑賞**、🏷️ **會員購物金回饋**。
4. **主題策展 Bento 網格（Curated Collections）**：
   * **日常器皿（Dining & Kitchen）**
   * **手織布品（Textile & Living）**
   * **木作與生活道具（Wooden Utensils）**
5. **豐富商品目錄（24 款精選商品）**：
   * 包含陶作器皿、長纖純麻圍裙餐墊、黑胡桃雕刻托盤、大豆蠟燭等。
   * 展示不同庫存狀態（正常供應、庫存緊張、`WD-POT-07` 展示售罄狀態）。
6. **品牌工藝理念專欄（Brand Philosophy）**：
   * *「把時間花在看不見的細節上」*，傳達品牌與工匠精神。
7. **品牌誌生活專題（Woven Journal）**：
   * 《器物日常：如何養出一只溫潤質樸的陶杯？》（保養指南）
   * 《晨光與亞麻：讓空間自然呼吸的織物佈置學》（居家風格提案）
8. **會員專屬禮遇邀請**：
   * 引導訪客註冊領取首購購物金。

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
   * 檢視 4 階會員等級（織日會員、銀卡、金卡、黑卡 VIP）倍率與購物金回饋百分比。
7. **ERP 投遞與死信佇列（/erp & /dlq）**：
   * 檢視交易事件的 JSON Payload 預覽與手動重送功能。
8. **系統健康度與 MCP（/system）**：
   * 檢查資料庫、Worker 與已安裝 Extension 狀態。
   * 檢視公開的 MCP AI 工具列表（`search_products` / `get_order` / `adjust_inventory` 等）。
