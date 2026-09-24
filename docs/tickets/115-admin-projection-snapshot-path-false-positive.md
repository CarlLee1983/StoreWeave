# 115 — Admin projection 路徑誤判

**問題：** `scripts/build-projections.mjs` 的 Admin forbidden-source 規則對完整輸入路徑搜尋 `db`。ForgePilot 快照目錄若含這兩個字元，例如 `WI-017-b4d1dba15801`，Rollup 的 `\0/.../node_modules/react-dom/...` 虛擬模組路徑會被誤判為資料庫實作，導致 Admin projection 與 release baseline 測試失敗。同一程式碼在其他快照路徑的聚焦測試通過。

**狀態：** 待實作；SW-137 不修改此範圍外的 projection 判斷。

## 驗收

- [ ] 先將 Rollup 虛擬 ID 與工作區絕對路徑正規化為穩定來源路徑，再套用 Admin forbidden-source 規則；仍拒絕真正的資料庫、provider 與 server 實作。
- [ ] 以含 `db` 的工作樹路徑及 `\0` 前綴虛擬 ID 建立回歸測試。
- [ ] 聚焦 Admin projection、release baseline 與 `make verify` 通過。

## 證據

- ForgePilot `VR-024`／`EV-039` 在 `WI-017-b4d1dba15801` 快照的 unit 階段失敗，錯誤指向 `react-dom.development.js?commonjs-exports`，並標示為 `Admin browser implementation` forbidden source。
- 同一候選在主工作樹執行 `tests/architecture/release-baseline.test.ts` 四例通過；誤判來自快照路徑字元，而非 SW-137 的 HTTP 行為。
