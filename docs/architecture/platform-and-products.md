---
description: 理解模組化單體、平台與產品的責任，以及 Release 如何在建置時組裝應用。
pageClass: architecture-page
---

# 平台、產品與 Release

StoreWeave 的共用程式負責讓應用執行，產品模組負責決定業務上什麼事情可以發生，Release 則選取兩者，組成一份可交付的應用。理解這三個角色之後，才容易判斷一項需求應放在哪裡，以及它會影響哪些產品。

## 為什麼採用模組化單體？

每份應用部署以同一套資料庫協作，API 與 Worker 分別執行前景請求和背景工作；產品內的模組沒有各自獨立部署成服務。這是 [ADR 0001：Modular Monolith](../adr/0001-modular-monolith.md) 選擇的模組化單體。

這個選擇讓跨模組操作能共用一次資料庫交易。例如 Commerce 建立 Order 時，商品檢查、庫存預留、訂單寫入與 Outbox 事件可以一起成功或一起回滾。若把這些模組拆成網路服務，就必須另外處理跨服務失敗與一致性。

單體不代表模組可以任意跨表存取。每個模組仍擁有自己的資料與 migration，其他模組透過它公開的 service 協作。這保留了責任邊界，也讓後續升級較不容易覆蓋客戶差異。代價是模組共用程序資源，不能直接為某個模組單獨擴縮；未來若需要拆分服務，仍須重新驗證交易與失敗語意。

## 平台與產品各自知道什麼？

[`packages/platform`](../../packages/platform/) 提供 Command、Query、Event、Job、Permission、Extension、Theme 等機制。它知道如何驗證輸入、授權、執行交易和排入工作，但不應知道商品、庫存或訂單的規則。這項依賴方向由 [ADR 0010](../adr/0010-platform-is-domain-agnostic.md) 定義。

產品模組擁有業務語意。例如 [`packages/commerce`](../../packages/commerce/) 處理 Cart 與 Order；[`packages/booking`](../../packages/booking/) 處理 Property、Room Night 與 Reservation。Order 是價格已凍結的購買請求，Reservation 是一段住宿日期的承諾；兩者都涉及付款，也不因此共用同一個狀態模型。

| 角色 | 負責的事情 | 具體例子 |
| --- | --- | --- |
| Platform | 領域中立的執行、資料與介面機制 | CommandBus、授權、Outbox、背景工作 |
| Base Module | 不帶特定產品交易語意、由產品選用的完整能力 | 內容、媒體、通知能力 |
| Product Module | 某個產品的資料、規則、流程與公開契約 | Commerce 的 order、Booking 的 reservation |
| Product Release | 選取能力與產品模組，組成可獨立建置、部署並使用獨立資料庫的應用 | Commerce Release、Booking Release |

Platform 與 Base Module 的分別在於責任，不能只看它們是否放在同一個父目錄。目前內容、媒體與通知等可選能力也位於 `packages/platform`。當能力在至少兩個實際產品中的語意與生命週期一致，才有依據把它提升為 Base Module；不為了目錄整齊先抽出萬用付款或萬用庫存。

共用範圍也包括 HTTP、Admin、CLI、建置與維運工具，沒有全部集中在 kernel。kernel 負責 Runtime 等組裝機制；共用 CLI 則擁有 migration、診斷、備份還原等流程。完整責任分工與可復用性的驗收目標見[通用應用基底與產品分工](../reusable-application-base.md)。

## Release 如何把能力組成一個產品？

[`packages/platform/release`](../../packages/platform/release/) 定義領域中立的 Release manifest、target projection、bootstrap 與組裝契約檢查；實際產品的選擇放在 [`packages/releases`](../../packages/releases/)。

ReleaseDefinition 描述產品的身分與組成，是邏輯上的單一建置來源。它透過 **target projection（各建置目標的組裝入口）**，分別提供 server、worker、Admin、CLI、config 與 storefront 所需的內容。各目標只匯入自己的入口，避免把後端 factory、Nest adapter 與 React 頁面一併帶進瀏覽器產物。

例如 Commerce Release 選取商務模組、可用 Extension、角色與前台；Booking Release 選取住宿模組與自己的頁面。共用 API 或 CLI 讀取所選入口，不應靠 `if (releaseId === 'booking')` 判斷業務行為。更換產品的工作在 ReleaseDefinition 與其 contributions，不需要重寫 kernel。

Command 與 Event 的名稱也由模組擁有。`commerce.order.placeOrder` 是 Commerce 的公開契約；平台只檢查事件名稱符合 `<context>.<aggregate>.<action>.vN` 等格式。`cms.post.published.v1` 與 `booking.slot.reserved.v1` 是格式示例，不代表目前已登記這兩個事件。

## Theme 與 Extension 怎麼表達客戶差異？

Theme 負責產品前台的呈現：品牌、版型、樣式與 Theme options。它使用模組提供的頁面資料，業務規則與資料仍由模組擁有。例如調整商品頁的品牌視覺應從 Theme 著手；改變可售數量的計算則屬於產品模組。

Extension 透過 SDK 接入外部整合或特殊需求，例如金流與 ERP。它取得的是受限的 ExtensionContext，透過 Command、Query、Job、隔離的 Store、Provider 與 Secret 協作，不直接取得資料庫交易物件。

依 [ADR 0002](../adr/0002-build-time-extension-assembly.md)，Extension 在**建置時**編入 Release。設定檔只能啟用或停用該 Release 已經包含的 Extension，無法在正式主機上傳新程式碼即時安裝。啟用未包含的 id 會在啟動時失敗；新增客戶專屬 Extension 要加入建置組合，再重新產生與部署 Release。

因此客戶差異通常依序落在設定、Theme／Theme options，以及已編入的 Extension 組合與設定。這個方式能在交付前檢查相容性，也要求團隊維護不同客戶的建置組合。

## 目前哪些 Release 可以建置？

以下依目前的[建置登記](../../scripts/releases.mjs)與[共用基底狀態說明](../reusable-application-base.md)區分工程狀態；可建置不等於正式環境已通過所有產品驗收。

| Release | 目前狀態 | 閱讀時要注意的限制 |
| --- | --- | --- |
| Base | 已有 runtime 與各目標 projections，可建置 | 提供所選共用能力，不因此載入 Commerce 資料與規則 |
| Commerce | 已有產品模組、Theme、Extension catalog 與各目標 projections，可建置 | 哪些 Extension 編入產物由 Commerce 組裝決定 |
| Booking | 已有獨立產品模組、Theme 與各目標 projections，可建置 | 部署範本與完整外部 release gate 仍依產品規格追蹤；目前沒有 native release 設定 |
| Dining | 已有 Release 的 config projection 與產品模組實作 | 尚未登記於 `scripts/releases.mjs`，目前不可當成完整可建置 Release |

另外，`file-requests` 已登記為可建置的獨立模組範例，用來驗證非商務模組如何使用共用基底。它不是完整產品交付的替代證據，native release 也未設定。操作方式見[模組開發](../module-development.md)。

下一章：[一次請求如何讀寫資料](requests.md)。回到[架構總覽](../architecture.md)。
