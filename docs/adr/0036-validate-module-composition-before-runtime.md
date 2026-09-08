# 0036. 啟動前驗證模組組裝，分開初始化與操作相依

- 狀態：accepted；B01 實作、驗證與獨立 Sol 雙軸審查通過。
- 日期：2026-09-07

`PlatformModule.name` 是唯一穩定識別，也是既有 event subscriber id；`version` 取自模組 package.json，`baseVersionRange` 對應 Base ABI。package 的 `0.1.0` 與 `PLATFORM_VERSION` 的 `1.0.0` 不合併。`MigrationSet.module` 保留歷史 namespace，因此 `platform-identity` 擁有 `identity` migration 合法。

整圖先驗證、再建立 Database 與註冊 handler。required／optional 靜態相依以確定順序排序並拒絕 cycle；optional 存在時仍檢查版本。constructor 注入的同步操作使用帶來源的 `BoundModuleCapability`，驗證提供者、能力、版本與實際 binding；它們不決定初始化順序。現有 shipping／refund 的相互檢查是在同一交易內執行的操作，維持原有 Order lock 順序，不為排序移除檢查。Outbox 訂閱只驗證事件存在，不構成同步初始化邊。

`platform` 節點擁有既有共用 migration／資料表與 `platform.event.deliver`，避免另外維護保留名稱清單。`platform_migrations` 仍由 migrator bootstrap 建立，沒有搬入 migration SQL。Core subscriber 的 command executor 只允許自身 command 或事先宣告的精確 owner／name／descriptor version，且外部 owner 必須有相依或 binding；Extension 原有限制不變。Job executor 的完整能力與可靠性由 B04 處理。

Cart、Coupon、Promotion、Identity 收回 repository 的跨模組公開匯出，以 owner 提供的交易操作與資料投影取代。這是支援介面的資料 ownership、組裝及授權約束；trusted Node 仍能自行 import SQL，不宣稱惡意程式 sandbox，也不建立全域 service locator。B02 承接 release 選取、設定、migration checksum／history、生命週期與清理。B01 不改既有 migration id／SQL、HTTP／Command／Query／Event payload 或 Extension SDK；回復程式即可回到原組裝方式，無資料轉換。

## Falsified if

`packages/platform/kernel/src/module-graph.ts` 不能在 `packages/platform/kernel/src/runtime.ts` 建立 Database 前拒絕缺相依、重複 owner 或漏接 binding，或 `tests/integration/module-consumers.test.ts` 無法保證注入操作失敗時同交易回滾，或 `tests/integration/refund-domain.test.ts` 的出貨／退款互斥失敗，則重開本決策。若 `packages/commerce/*/src/module.ts` 開始要求有順序的副作用初始化，必須重驗靜態相依與操作 binding 的區分，不能繼續把真正初始化 cycle 當成合法操作關係。
