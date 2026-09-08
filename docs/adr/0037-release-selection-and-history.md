# 0037. Release 統一選取模組，歷史驗證與啟用分開

- 狀態：accepted；B02 實作、回歸、原生／Docker／Debian 驗證與獨立 Sol 雙軸審查通過。
- 日期：2026-09-08

版本化 `ReleaseDefinition` 是 API、worker、CLI、seed 與 build 的選取來源。Base 只載入選定基礎模組，不要求 Commerce 設定、角色或資產；Commerce 保留既有模組。必要 seed 與明確指定的 demo seed 分開。Build manifest 記錄 release、ABI、模組與 migration pins，原生安裝與 CLI 使用同一個完整目錄驗證器；內容摘要證明一致性，不代表發行者簽章。

Migration pins 包含 owner、原 id、phase、順序與 SQL checksum。既有 domain SQL 不改寫。有效歷史保留停用 owner 的 metadata，停用不 import runtime 或執行其 SQL；重新啟用驗證保存的歷史與資料表。未知歷史、改寫 prefix 或向前啟用時降版遭拒，沒有自動 DROP 或清除 migration history。

啟用先在單一 checked-out connection 取得 PostgreSQL advisory lock，驗證／套用 migration，然後釋放該鎖。Extension setup 在鎖外執行，finalizer 再次持鎖，完成 CAS／待處理工作檢查並原子記錄 registry 與 release history。Setup 可能已執行才發現 finalizer 過期；失敗時關閉部分建立的 runtime。API 只接受可啟用的選定 release，worker 與一般操作要求目前 release 已啟用。初始化失敗逆序清理；worker 關閉有限時 drain。這些程序鎖不會阻止任意外部 SQL writer，維護流程仍要求操作者停妥外部寫入。

B01 舊三欄 migration ledger 無法證明當年執行的 SQL 或 runtime bytes。一次性採納只接受固定 Commerce 0.1.0 catalog、相符 id／phase 與現在保存的 SQL prefix，記錄明確 evidence；`historicalSqlVerified` 與 `historicalRuntimeVerified` 永遠保持 false。不能將此採納紀錄宣稱為追溯驗證。

原生安裝與 CLI transition 共用持久 `.transition.lock` inode，子程序繼承開啟的描述符。候選先在私有目錄驗證，正式版本不覆寫，`current` 原子切換。`.deb` 只管理獨立 tarball 媒體；dpkg 不擁有 live release、設定或 unit。媒體使用獨立套件名稱，與持有 live files 的舊式套件共存，不接管舊套件檔案；啟用一律由原生安裝器或 CLI 處理。

升級前的 paired snapshot 綁定實際 PostgreSQL snapshot、完整歷史、sequence、physical database identity、source／candidate tree 與 dump 摘要。持久 journal 記錄 migration 與 activation 階段；中断後可續跑同一候選，不能任意換候選。向前 migration 失敗不自動回滾 DB：已套用 SQL、快照與 journal 保留，服務保持停止，current 不變。操作者可重試同一候選，或以新的確認與停寫聲明執行明確快照還原。B01 bridge 在採納 metadata 前先保存 raw safety snapshot，採納後另建 paired snapshot；兩者使用不同明確種類，不偽裝成現代歷史。

還原在 PostgreSQL 17 的獨立 scratch database 完成，保留 owner、ACL、資料庫設定與歷史。驗證 DB、私有 source CLI status、再驗 DB後，依 journal 與實際 OID mapping 原子交換資料庫名稱，再切換程式。B01 status 使用強制 public search path，檢查舊文字格式的 pending 區為空；舊 status 含 CREATE IF NOT EXISTS，不能稱為唯讀 SQL。還原取代整個資料庫，不合併資料或執行 down migration；快照後寫入只保留在 quarantine。Paired 還原重現捕捉的 metadata；raw B01 safety 還原則回到三欄 ledger、沒有 B02 metadata。需要 maintenance superuser、既有 role／extension／tablespace、管理中服務停止與外部寫入者停妥。原資料庫保留為 quarantine，不自動刪除，也不承諾逆轉任意資料轉換。未知 crash 狀態保留供人工判斷，不盲目重用或清理。

## Falsified if

若 `packages/platform/bundle/src/releases/base.ts` 或 `scripts/build.mjs` 產物載入未選 Commerce runtime，或 `packages/platform/db/src/release-history.ts` 接受改寫 prefix／未知歷史，或 `tests/integration/migration-lock.test.ts` 無法保證同 connection 鎖定，則重開本決策。若 `tests/integration/cli-upgrade-paired.test.ts`、`tests/integration/cli-legacy-upgrade.test.ts` 無法在中斷後依原 journal 恢復正確 DB／程式配對，或 `tests/integration/deb-media.test.ts` 顯示 dpkg 會改動 live installation，必須先修復邊界。若 `tools/cli/src/verify-restored-database.ts` 無法驗證指定 PostgreSQL 版本的 owner／ACL／設定／歷史，不可放寬驗證來宣稱該版本受到支援。
