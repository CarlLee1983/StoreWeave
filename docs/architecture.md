---
description: 循序理解 StoreWeave：從平台與產品分工，到請求、事件、模組邊界與介面資料流。
pageClass: architecture-page
---

# 架構

StoreWeave 把共用平台與產品規則分開，再由 **Release 組裝成可部署的應用**。
這份導讀帶你從整體分工開始，跟著一次付款請求理解交易，再看事件如何送到外部服務。

想先把專案跑起來、做出自己的網站，請從[動手學：啟動網站與打造 Blog](learn/index.md)開始；那裡有操作步驟、預期結果與擴充練習。
想先理解原理，可以依下列章節順序閱讀。每章先解釋問題與責任，再用例子展開運作方式，最後列出限制與來源。
已經知道要找什麼時，可以從文件導覽直接選章，或使用[程式碼地圖](architecture/code-map.md)。

## 平台與產品

**第一章：一份應用由哪些部分組成？**

平台提供授權、交易、事件與工作等機制；產品模組擁有商品、訂單或住宿預訂的規則；Release 選擇並組裝這些能力。
先理解這三層，再看 Theme 與 Extension 如何容納品牌與整合差異。

這章也說明模組化單體的取捨、各建置目標如何取得自己的組裝，以及目前各 Release 的工程狀態。

[閱讀第一章：平台、產品與 Release →](architecture/platform-and-products.md)

## 一次寫入的完整路徑

**第二章：按下付款後，誰檢查權限、誰改資料？**

以一次付款請求串起 Actor、Controller、CommandBus 與 handler，區分「請求已接受」和「付款已確認」。
接著說明資料庫交易的範圍、同一請求重送時的冪等保護，以及 QueryBus 的讀取流程。

[閱讀第二章：一次請求如何讀寫資料 →](architecture/requests.md)

## 事件如何抵達 Extension

**第三章：請求結束後，工作如何繼續？**

付款結果與事件一起落庫後，Outbox 先建立各訂閱者的投遞工作，Worker 才執行。
以 ERP 推送為例，逐步理解重試、去重、失敗隔離，以及為什麼本機成功不能直接代表遠端成功。

[閱讀第三章：事件與背景工作 →](architecture/events-and-jobs.md)

### 週期性工作

同一章後半段說明固定間隔、cron、時區、有限追補與重疊策略。排程負責決定何時排入，實際工作仍由 Worker 執行。

[直接閱讀週期性工作](architecture/events-and-jobs.md#週期性工作-排程器只決定何時排入)。

## 模組邊界

**第四章：資料和規則由誰負責？**

一個模組宣告自己擁有的資料、相依與能力。組裝時先檢查是否接齊，執行時透過公開 service 協作。
本章比較同交易的跨模組操作與非同步事件，再說明資源 scope、上傳入口，以及 Extension SDK 的能力範圍。

[閱讀第四章：模組邊界與資料責任 →](architecture/modules-and-data.md)

## 介面共用同一組 handler

**第五章：網頁、API、後台與 CLI 如何使用同一套能力？**

介面負責接收輸入與呈現結果，產品規則由共用 handler 擁有。
本章從 REST、Storefront SSR、Admin、MCP、CLI 與 Worker 的角色開始，細看模組頁面、Theme renderer 與 Session outcome 的分工。

[閱讀第五章：介面與後台資料流 →](architecture/interfaces-and-admin.md)

### Admin 資料流

後台還需要處理瀏覽器的查詢快取與「結果未知」的操作。這一節說明 QueryClient、HTTP transport，以及換帳號時為什麼要清除舊的狀態。

[前往第五章的後台說明](architecture/interfaces-and-admin.md)。

## 目錄結構

**第六章：理解流程後，回到程式碼找實作。**

程式碼地圖依應用入口、平台能力、產品組裝、產品模組與整合分類，保留各目錄的責任說明。
它也提供從需求找擁有者的例子，讓你知道應從哪一層開始追查。

[查閱第六章：程式碼地圖 →](architecture/code-map.md)

## 延伸閱讀

- [通用應用基底與產品分工](reusable-application-base.md)：跨產品共用的範圍與目標。
- [架構決策紀錄](adr/README.md)：選擇的原因、代價與重新檢討條件。
- [模組開發](module-development.md)：實際新增模組的步驟。
- [Extension 開發](extension-development.md)：整合外部服務的契約與方式。
- [Docker 部署](deployment-docker.md)與[原生部署](deployment-native.md)：把 Release 交付到執行環境。
