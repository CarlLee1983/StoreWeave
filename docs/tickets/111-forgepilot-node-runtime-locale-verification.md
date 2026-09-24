# 111 — ForgePilot 驗證的 Node 選版與日期測試相容性

**問題：** 根目錄 `package.json` 只宣告 `engines.node: ">=22"`。ForgePilot 在
2026-09-23 的 snapshot 驗證中從本機已安裝版本選到 Node 24.21.0，但平常的
`make verify` 使用 Node 22.17.1。Node 24 下
`apps/admin/src/pages/OrdersPage.test.tsx` 的 zh-TW 日期案例因 ICU 空白字元
正規化差異失敗；同一份程式在 Node 22 下通過。

**狀態：** 待處理。Booking 工單暫以僅作用於 ForgePilot 驗證程序的 Node 22
執行環境避開差異；未修改 repository toolchain 宣告或 Admin 程式。

## 驗收

- [ ] 決定並記錄 CI／ForgePilot 支援的 Node 版本策略：釘住驗證版本，或讓測試與程式在所有宣告支援的版本下都正確。
- [ ] zh-TW 日期案例在選定的支援版本下穩定通過，且不靠跳過測試或改寫驗證輸出。
- [ ] `make verify` 與 ForgePilot snapshot 驗證對同一候選使用可追溯、相容的 runtime。

## 證據與邊界

- ForgePilot `VR-001`：Node 24.21.0，Admin OrdersPage 日期案例失敗。
- ForgePilot `VR-002`：Node 22.17.1，unit 1,452/1,452、admin 351/351 通過；整合階段另受本機高負載逾時影響，不能算全套通過。
- 本票不修改 Booking 行為、Reservation 權限、日期產品格式或既有工單的驗收狀態。
