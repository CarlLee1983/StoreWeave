# 119 — 已實作功能的文件與交付狀態同步

**問題：** 入口文件仍以 Commerce 為唯一產品，Booking 缺少使用與建置指南；規格索引
仍把已實作的 0001–0007 標為 `ready-for-agent`，Booking 規劃文件仍寫「尚未授權實作」。
維運文件也仍稱後台帳號頁未實作，架構文件固定寫 16 條 Admin route。

**範圍：** 依目前程式、既有工單與驗收紀錄更新 README、架構、規格狀態、Booking
指南及維運說明。保留原規格、歷史派工紀錄及未完成的外部 release gate；不改程式行為。

## 驗收

- [x] 入口文件能分辨 Base、Commerce、Booking，並連到 Booking 指南。
- [x] Booking 指南說明目前功能、建置、設定、前後台入口及交付界線。
- [x] 規格索引與頁首不再把已落地的 Commerce 功能寫成待派工；Booking 狀態區分工程實作與完整驗收。
- [x] 架構與維運文件對齊 release projection 與已存在的後台帳號頁。
- [x] `make verify` 第二次完整執行通過：integration 115/115 檔、1032/1032 案例；首次執行僅 Booking 通知重試案例失敗（見[工單 120](120-booking-notification-drain-failure-count.md)）。
- [x] 文件連結與 `git diff --check` 通過；獨立文件審查及 delta 複查沒有剩餘重大發現。

## 範圍外

外部 ECPay staging、商家 UAT、正式部署設定、未解的測試基礎設施工單及
Spec 0011 §9 的完整證據核對，不因本次文件同步而宣稱已通過。
