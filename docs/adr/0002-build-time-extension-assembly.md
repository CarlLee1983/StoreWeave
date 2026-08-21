# 0002. Extension 採建置時組裝，不支援執行期上傳

- 狀態：accepted
- 日期：2026-08-21

## 背景

WordPress 式的「後台上傳 plugin」很方便，但代價是：任意程式碼在正式主機執行、
相依套件在正式主機安裝、升級時無法預先驗證相容性。

我們的部署前提是「正式主機不得安裝 Node.js、pnpm、TypeScript 或編譯工具」——
執行期上傳 Plugin 與這個前提直接衝突：上傳的 TypeScript 需要編譯，上傳的 npm 套件需要安裝。

## 決策

Extension 在**建置時**編進 Release Bundle（`packages/platform/bundle/src/modules.ts` 的
`AVAILABLE_EXTENSIONS`）。`commerce.yaml` 只能**啟用或停用** Release 內已存在的 Extension，
啟用一個不在 Release 裡的 id 會在啟動時直接失敗，並列出可用清單。

每個客戶的差異透過三件事表達，都不需要改 Core：

1. `commerce.yaml` 設定
2. Theme 與 Theme options
3. 啟用的 Extension 組合與各自的 configuration

客戶專屬 Extension 的作法是：在自己的建置分支加入一個 package、加進 bundle、重新產生 Release。

## 後果

- Extension 相容性在建置時就能驗證（`runExtensionContractChecks` 是 CI 的一部分）。
- 正式主機只有已編譯的 JavaScript，沒有編譯工具，攻擊面小。
- 代價：新增 Extension 需要重新建置與部署，不能在後台即時安裝。
- 代價：多個客戶若各有專屬 Extension，會產生多條建置分支；這是刻意的取捨——
  我們寧可管理建置矩陣，也不要在正式主機執行未經驗證的程式碼。

## Falsified if

出現「必須讓非工程角色在不重新部署的情況下安裝新功能」的需求，
使得 `packages/platform/kernel/src/extension-host.ts` 必須支援執行期載入模組，
或 `packages/platform/bundle/src/modules.ts` 的靜態 `AVAILABLE_EXTENSIONS` 必須改成動態掃描目錄。
