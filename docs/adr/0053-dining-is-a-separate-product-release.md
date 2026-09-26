# 0053. Dining 是獨立的餐廳訂位 Product Release

- 狀態：accepted
- 日期：2026-09-26

餐廳訂位以獨立的 Dining Product Release 交付，與 Commerce、住宿 Booking 分開建置、部署並使用資料庫；
它沿用領域中立的 Platform 與語意確實適用的 Base 能力，餐廳訂位申請、桌型供應與已接受訂位則由 Dining
自己的領域模型擁有。住宿 Reservation 在建立與待付款期間即占房晚；餐廳訂位申請在店家接受前不占桌，
兩者的供應單位和生命週期不同，不能因名稱相似而共用同一個訂位模型。

這個邊界延續 [ADR 0010](0010-platform-is-domain-agnostic.md) 與
[ADR 0052](0052-booking-is-a-separate-product-release.md) 的產品組裝原則。若 Dining 的核心流程必須依賴
Commerce Order 或住宿 Booking Reservation，或要求 Platform／Base 加入產品名稱分支，應重新檢查模組邊界。

第一版由單一 `dining-reservation` Product Module 擁有桌型、可訂時段、申請、已接受訂位與占桌規則，
內部再分開各項責任。接受訂位與減少桌數都必須看同一份容量承諾；現在拆成公開的供應與訂位模組，
會要求跨模組同步占用資料，增加雙向依賴或資料遷移成本。待出現獨立演進需求，再以明確的資料遷移拆分。

Dining 決定自己資料的個資保存期限，Base Notification／Mail 則透過產品中立的能力清除其擁有的通知與寄信個資，
保留不含顧客識別資訊的必要去重與稽核證據。Dining 不跨模組直接操作 Base 資料表；
結果不明的 Email 由授權的後台動作透過 Base Notification 能力明確重送，並更新同一份寄送證據。
