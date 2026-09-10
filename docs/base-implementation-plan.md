# StoreWeave Base 執行與派工計畫

- 規格：[Spec 0009](specs/0009-complete-modular-base.md)，能力範圍與最終驗收以該文件為準。
- 日期／盤點基準：2026-09-07，`1f4470d`；Spec 0008 Ticket 81–90 已完成，保留已驗證的未提交工作樹。
- 工作包 B00–B17 是本機規劃識別，不是 GitHub Issue，也不佔用既有 Ticket 92 之後的編號。
- 執行狀態：B00–B04 `done`，見 [B00 驗證紀錄](base/b00/README.md)、[B01 紀錄](base/b01/README.md)、[B02 驗收對照](base/b02/acceptance.md)、[B03 紀錄](base/b03/README.md)（2026-09-08 結案，final-source gates 與獨立 review 齊備）、[B04 紀錄](base/b04/README.md)（五片實作與三份獨立 5b review 全部結案，P0／P1 皆已修並附量體證據；typecheck、unit、完整 integration 與 Docker／native smoke 實跑通過），依 [B01–B04 派工契約](base/b00/next-work-cards.md) 執行。B05 `in_progress`，由另一條工作線在獨立分支進行；本文件未核對其交付，結案證據以該線提出者為準。[B12](base/b12/README.md) `done`（三片實作與三份獨立審查全部結案，CRITICAL／HIGH 皆已修並補回歸；typecheck、unit、admin、完整 integration 與 Docker／native 各兩種 release 的 smoke 實跑通過）。B06–B09、B11 `done`。[B13](base/b13/README.md) `in_progress`（2026-09-10 開工，決策見 [ADR 0045](adr/0045-modules-declare-storefront-pages.md)）。其餘 B10、B14–B17 `planned`，依下列前置及契約審查解鎖。planned 不代表可直接丟給多位 writer 同時開工。

## 1. 接手與派工方式

1. 讀 Spec 0009、本文件、適用規則、`git status` 及目前 HEAD；核對前置工作包交付證據。
2. 每條已派工作線一次只取一個可驗收切片；跨 session 的啟動、ownership 與整合依 §3.1。大工作包可拆子票，但每項 F 能力必須保留 owner，不因拆票漏掉完整目標。
3. 實作前把 interface、目標檔案、驗收、測試命令與移轉方式具體化為該次派工單；涉及選型的包先完成指定比較，主代理做決策。
4. 每片先交付可運作的能力與呼叫端，再交接下一片；套件安裝、接口空殼或只有成功路徑不能單獨關閉工作包。
5. 獨立審查、必要驗證完成後，才記錄完成狀態與下一個可執行前沿。待驗證環境明列，不能宣稱整體 base 完成。

歷史接手指示曾授權原工作流程依序完成 B00–B17；目前各 session 的執行範圍以使用者對該 session 的任務指派為準，不能引用本段將本次文件工作擴大為實作。既有 B03 session 的授權與 Spec 0008 進度保留。commit、push、GitHub 建單／留言、merge、publish、部署與對外寄信仍按使用者授權執行。

## 2. 模型與單一 writer

| 責任 | 執行者 | 可交付範圍 |
| --- | --- | --- |
| 統整規格、風險與整合 | 主代理，保留當前模型 | 共用契約、資料移轉、身分／授權、外部副作用、Queue／排程／lock、release 切換 |
| 架構／高風險分析 | architect，Sol／high | 自含且唯讀的選型、契約與資料／安全設計分析 |
| 廣泛盤點／套件查證 | scout，Luna／medium | source locations、官方相容資訊、已有實作與缺口；不重複已消化的 inventory |
| 有界實作 | implementer，Terra／medium | 契約已定的純模板、UI、文件、測試工具等；不自行擴大安全／資料／公開契約 |
| 一般獨立審查 | reviewer，Terra／high | 有界 UI、文件與無高風險變更 |
| 高風險獨立審查 | reviewer，明確指定 Sol／high | 跨模組、公開契約、資料、權限、外部副作用、併發與最終整合 |

高風險 implementation 留在主代理；如要交給 Sol／high worker，另需使用者明確授權，
不能將高風險票默默降給 Terra。2026-09-09 效率調整取代先前有界派工一律 Terra／high 的覆蓋：後續派工依上表角色預設，日常實作使用 medium；具體難題才說明原因提高強度。既有 session 不會因此自動切換模型／強度；使用者對個別 session 的明確選擇仍優先。Sol／high 風險分析與獨立審查保持不變。

同時最多四個 active agents，包含主代理。設計期可用「主代理＋architect＋scout」，
實作期可用「主代理＋一個有界 implementer＋scout／另一個無重疊 implementer＋reviewer」。
審查必須讀整合後的差異，不由原 writer 自我核准。相依的工作不能為了填滿 slots 提早開始。

共用接線檔由主代理單獨擁有：`kernel/{runtime,module,theme}.ts` 對應的實際 src 檔、
`bundle/src/*`、`config/src/schema.ts`、`apps/api/src/app.module.ts`、
`apps/admin/src/{App.tsx,api.ts,routes.tsx,main.tsx}`、根 `package.json`／lockfile／TS／build／CI 設定。
其他 session／子代理只回報所需接線 diff／依賴，經整合 owner 寫入；上述檔案及每個 migration history 同時只有一位 writer。跨 session 時，本節的共用檔案主代理就是 Session A，各工作線主代理僅擁有派工單列出的局部實作。

## 3. 依賴圖與階段出口

前置依賴以本表為唯一來源；各包詳細內容不重複維護另一套 Blocked by。

| 包 | 交付 | 前置 | 主要執行／審查 |
| --- | --- | --- | --- |
| B00 | 基準對齊、Queue 選型驗證與派工契約 | — | 主代理＋Sol 分析／Sol |
| B01 | 模組版本、相依、資料與能力契約 | B00 | 主代理／Sol |
| B02 | Base／Commerce 組裝、設定與 migration 選取 | B01 | 主代理／Sol |
| B03 | 通用 HTTP、安全輸入與傳輸文件 | B02 | 主代理／Sol |
| B04 | Queue／Outbox 完整可靠性 | B02 | 主代理／Sol |
| B05 | 完整排程與工作執行管控 | B04 | 主代理／Sol |
| B06 | 通用 Mail 正式服務與模板 | B04、B09、B12 | 主代理；模板可委派／Sol |
| B07 | Notification 通道與商務通知遷移 | B06 | 主代理；既定 UI 可委派／Sol |
| B08 | 通用 Identity 與安全營運閉環 | B03、B06 | 主代理／Sol |
| B09 | 本機／S3 Storage 與授權上傳 | B03、B12 | 主代理／Sol |
| B10 | 媒體管理與圖片處理 | B04、B09、B13 | 主代理；媒體 UI 可委派／Sol |
| B11 | 共享 Cache、失效與 lock | B02 | 主代理／Sol |
| B12 | HTTP client、翻譯、時間及安全工具 | B03 | 主代理；字典／純格式化可委派／Sol |
| B13 | 模組化 Admin／Theme／頁面掛載及帳號／通知 UI | B03、B07、B08、Spec 0008 Ticket 90 完成並驗收 | 主代理；純 UI 可委派／Sol |
| B14 | 網站設定、內容／Blog 與媒體遷移 | B08、B10、B12、B13 | 主代理；既定頁面可委派／Sol |
| B15 | CLI、release、metrics、備份升級與復原 | B05、B07、B08、B10、B11、B12、B14 | 主代理；操作文件可委派／Sol |
| B16 | 獨立模組 SDK 範例與契約測試 | B05、B07、B08、B10、B11、B12、B13 | 主代理；已定測試工具可委派／Sol |
| B17 | 三種網站、跨版本及整體驗收 | B15、B16 | 主代理＋獨立驗證／Sol |

階段出口：

- **M0 設計可派工**：B00–B01。已有具體契約、選型證據及下批票，不開始全量空接口 scaffold。
- **M1 應用可獨立組裝**：B02–B04；基礎 HTTP／worker 可不載入 commerce，商店 release 保持運作。這時還不是完整網站基底。
- **M2 共用服務可用**：B05–B09、B11–B12；服務有正式實作、故障測試與 HTTP／CLI 呼叫端。B07／B08 的新增 UI 尚待 M3，對應 F 項仍未全部完成。
- **M3 網站可組裝**：B13 → B10 → B14；通用殼、帳號／通知 UI 與內容／媒體完成，形象站／Blog 不要求商務功能。
- **M4 完整目標驗收**：B15–B17；部署、復原、獨立模組範例及所有 F 項閉環。M1／M2 不能改標為最終交付。

可並行的例子：B02 後 B03／B04／B11 的分析與隔離測試；B03 後先做 B12，再由 B09 使用其簽章契約；
有資源與檔案衝突時依序做，不用每個能力各開一個大 agent。B13 的 UI 不與 Spec 0008 同檔案修改並行。
無 calendar deadline；B00 先根據選型與首個切片實測成本補估算，再按工作包追蹤，不以 agent 數量換算工期。

### 3.1 多 session 派工（2026-09-08）

採「Session A 整合 owner＋Session B Queue 線＋Session C 共用服務線」。本節取代全專案一次只能推進一個 implementation 切片的排程限制；每條線仍一次一片，前置依賴仍以 §3 表格為唯一來源。
本次使用者要求先寫派工計畫；本文件交付不啟動新實作、建立 worktree 或授權 commit／merge 等操作。後續使用者指派 session 接手後，依以下 gate 執行。

#### 目前前沿與啟動條件

| Session | 已交付 | 目前工作線 | 交付出口 |
| --- | --- | --- | --- |
| A：整合 owner，原 session | B03 結案；B04 整合與 gate 排程 | 持有共用接線、migration history、整合基準與重型驗證排程 | 每片整合後的 source identity、review、checks、下一個可執行前沿 |
| B：Queue owner | B04（[紀錄](base/b04/README.md)、[驗收](base/b04/acceptance.md)） | B05 Scheduler，獨立分支 | 排程 cron／timezone／DST／misfire 與工作執行管控 |
| C：共用服務 owner | B12（[紀錄](base/b12/README.md)、[驗收](base/b12/acceptance.md)） | B09 Storage | 共用工具含真實 consumer；Storage 使用已驗收的簽章與時間契約 |

B03 與 B04 已依此排程結案：B04 的 DAG 前置雖只有 B02，實作仍放在 B03 結案後以免改動驗收基準。B、C 兩條 implementation 線現已同時開啟，B 承接 B05，C 承接 B12。

B04 與 B09 等 B06 前置均完成後，由 A 指定一位空出的工作線 owner 接 B06。後續 B07／B08、B15／B16 可在 §3 前置全數成立且 ownership 分開後並行；B13 → B10 → B14 保持既定順序。B11 排入空出的工作線，在 B15／B16 需要它之前完成，不為它常駐第四條 implementation 線。這是優先順序，不增加或刪除 DAG 依賴。

#### 實作邊界與契約

| Owner | 可寫範圍 | 交由 A 整合的需求 |
| --- | --- | --- |
| B | B04 card 中 jobs、outbox、kernel worker／job-registry／event-delivery／ops-module、Extension job facade 及專屬 regression tests；實際檔案在每片派工單列明 | module／runtime／bundle 註冊、config、根設定、migration SQL／id／順序與 history 的提案 |
| C | B12 的共用工具實作與指定 consumer／tests；B09 接手後為 storage adapters 與指定 HTTP routes／tests。新檔與 consumer 清單先由 A 確認 | 安全 transport 共用層、release 註冊、config、根設定、migration 提案；Admin 共用入口仍由 A 持有 |
| A | §2 共用檔案、migration history、跨線契約、整合與 gate 文件 | 對每項需求指定整合基準並回覆 consumer 可用版本 |

上表 B／C 的高風險範圍是待指派的實作 ownership。使用者明確指派獨立 session 接手該高風險範圍後，才由該 session 主代理保留其模型執行；不能只把子代理改稱「主代理」而轉交。若 A 使用子代理承接高風險 implementation，仍須已有使用者對 Sol/high worker 的明確授權並指定 Sol/high；未取得此授權時，高風險核心留在 A，B／C 僅做分析或已定義的低風險切片。已存在且涵蓋該範圍的授權無須重問。跨線契約由 A 決策，先取 Sol/high 分析，整合後由未參與實作的 Sol/high reviewer 審查。各 session 的子代理共用該線 ownership；協調總負載，不以另開 session 規避工具的 active-agent 上限。

開工前在派工單固定以下契約與對應測試；若需改動，先讓 A 更新受影響 consumer 與整合順序，再繼續依賴它的實作：

- B03 的 transport／auth／error 宣告與 B01／B02 的 capability、release registration 邊界沿用已驗收版本。
- B04 固定 job／subscriber／dedupe identity、payload version、occurrence／claim token、AbortSignal／clock、重送及外部副作用語意。B04 不暗中依賴尚未完成的 B12 工具；必要新依賴先回報 A。
- B12 固定 sign／verify／rotation、expiry／日期序列化、受信任目的地／redirect／redaction 與公開 import 入口。B09 必須等完整 B12 整合驗收，再從該基準開始；介面凍結本身不取代前置工作包完成。
- migration SQL 由工作線提出，A 統一寫入與分配 id／順序；每個 migration history 保持一位 writer。共用檔案需求以精確 diff 或接線清單交接，不讓各線各自修改後再猜測衝突語意。

#### Worktree、驗證與交接

1. **固定基準。** A 記錄已驗收的起始 commit；若尚無已授權 commit，A 從固定 source 產出相對指定 HEAD 的 binary patch、必要未追蹤原始檔清單／副本及內容 hash；新 worktree 從該 HEAD 建立，先檢查並套用 patch、補入清單檔案，再逐檔比對 hash。來源含秘密或既有資料／release 產物時不納入複製。比對通過前不開始 focused 工作。現有未提交修改由原 owner 保留；建立 worktree 後比對實際 source，不假設未提交檔案或 ignored 設定已帶入。每條線使用不同 worktree／branch，依專案既有命令建立自己的依賴環境。
2. **明確派工。** A 發出下方格式的派工單，填妥局部檔案、consumer、契約、測試與資源。僅接到分析任務的 session 保持唯讀；前置或 ownership 未齊的工作回報 blocker，轉做不依賴它的已授權範圍。
3. **分開資源。** 各線使用自己的測試 DB／schema、暫存路徑、port、Docker project／image tag 及 build／release 輸出。使用 smoke scripts 的隔離參數並核對實際值；不沿用商家 DB、既有 release 或其他 session 的資源。固定 `/tmp` 日誌檔名也須避開跨線覆寫。
4. **分層驗證。** 各線完成 focused tests 與適用 typecheck／unit checks。A 排程完整 integration、Docker／native build／smoke，同一主機一次一組重型 gate；Vitest 的 `fileParallelism: false` 不會協調多個程序。驗證期間固定 source，記錄命令、exit code、日誌及 source identity。
5. **逐片整合。** 線內交付後，A 在獲授權的整合方式下接入共用檔案，完成 §6 與各包要求的 checks、獨立 review 和修正。分支 focused PASS 不等於整合 PASS。B12 整合驗收後才交基準給 B09；B04 整合驗收後才交給 B05。若兩線碰到同一檔案或契約，A 先指定順序，受影響切片等待新基準。
6. **結案與回復。** A 更新工作包證據與下一片派工單。gate failure 由所屬線修正，再針對 source delta 重驗；尚未整合的變更可保留在原 worktree。已套用 migration 或產生外部副作用時，依該包資料版本／stop-drain／snapshot／對帳流程處理，不能把 git revert 當作資料回復。

#### 每片派工單格式

```text
Session／工作包／切片：
模式：唯讀分析或實作；本次目標與完成條件：
起始 commit 或 source snapshot／diff hash：
已完成前置與證據連結：
主代理 owner／worktree／branch：
可寫檔案、新檔與 consumer：
引用的已定契約、所需共用接線與 migration 提案：
focused tests／必要整合 gates／測試資源／執行時段：
獨立 reviewer 與結果：
交付 source identity／passed、failed、not-run checks／風險與回復：
交回 A 的事項與下一個可執行切片：
```

本輪文件變更理由是讓獨立工作線能並行，同時保留單一接線 owner 與前置 gates；驗證包含依賴表未變、文件連結、diff 與獨立審查。若協調成本過高，由 A 將下一片改排序列執行，保留各線成果與原前置／驗收要求。

## 4. 工作包派工卡

### B00 — 對齊基準與驗證選型

- **讀取／ownership**：本規格、`package.json`、jobs／worker／recurring／outbox、既有 tests、Spec 0008 與 Ticket 81–91；只改該次研究／派工文件及隔離驗證程式，不改 production runtime。
- **工作**：核對 `1f4470d` 與最新 HEAD、待處理本機修改、實際部署／資料狀態；修正派工狀態的證據。建立 Command／Query／Event／Job／MCP／HTTP／Extension bridge／SDK／config／CLI 的識別、owner、consumer 及相容矩陣。對既有 Queue 與 pg-boss 做相同 contract PoC。
- **選型門檻**：必測 Drizzle transaction rollback enqueue、dedupe 回傳 identity、replaceExisting 遇 running、crash／lease、DLQ 重送、schedule timezone、queue schema upgrade。比較缺口補齊＋長期維護與 adapter＋migration 成本，選一套；不可只按功能清單換套件。
- **出口**：Sol 分析與獨立審查、選定版本／license／Node／PostgreSQL 條件、ADR 草案及 B01–B04 可執行票。若候選不合，說明原因並以既有實作承接完整 F06／F07，不能刪功能。
- **驗證**：隔離測試 DB／package project；輸出可重跑命令與結果。SMTP／S3 套件在對應包做版本 PoC，不讓所有選型阻擋第一片。

### B01 — 模組公開契約

- **讀取／ownership**：`kernel/src/module.ts`、runtime、extension-sdk、contracts、`tests/architecture`；共同接線由主代理寫。
- **工作**：定義 module identity／semver、required／optional dependencies、服務能力宣告、資料 ownership、migration 集合；transport／Admin／Theme contribution 由 release adapters 組合，區分 trusted Module 和受限 Extension。
- **出口**：兩個具體 consumer（現有 commerce、非商務驗證模組）的組裝契約；缺依賴、cycle、重名、不相容版本、非法資源存取被拒絕。公開資料操作有清楚交易語意。
- **驗證／回復**：契約與 architecture tests；原 commerce module 可通過同一介面。若變更現有 SDK，定義相容期／遷移及移除條件，不在 interface 內暴露其他模組 repository。

### B02 — 真正可選的 Commerce

- **讀取／ownership**：bundle、config、runtime、db/migrator、API／Worker／CLI bootstrap、build scripts、deployments；主代理。
- **工作**：一份站點組裝宣告產生一致有效模組圖、設定及 migration／seed。seed 只載入已選模組，支援重跑且區分示範資料與必要初始化。拆出 base config，讓 commerce currency／provider／roles 等只由 commerce 提供；補 migration checksum／歷史完整性／順序檢查及生命週期失敗清理。
- **出口**：base-only 與 commerce 都能 build／bootstrap／migrate；乾淨 base DB 不含 commerce 表，未選模組不被 import／啟動／排程。既有部署設定能明確遷移。
- **驗證／回復**：獨立 DB 組裝整合測試、原有商店回歸；未知歷史／校驗漂移／同模組重複 id／錯序會拒絕啟動，已停用模組以唯讀歷史清單驗證及支援重新啟用。中途失敗逆序 cleanup、shutdown 限時 drain。保持 migration history，檢查未完成 jobs 與資料版本後才允許移除模組。此包不以「把選單藏起來」取代拆組裝。

### B03 — HTTP 與傳輸契約

- **讀取／ownership**：`apps/api/src` 的 AppModule／guards／filters／controllers、contracts、meta schema；主代理。
- **工作**：模組註冊 HTTP／callback routes，統一 validation、錯誤、JSON 日期、分頁、CORS／CSRF／rate limits、受控 proxy 與 body size；必要 middleware 用現有 Fastify／Nest 能力。
- **出口**：無 commerce 的站點 HTTP 正常；未註冊端點不可用；REST 的 inputs、responses、auth、errors 與路由有可驗證文件，可由既有 descriptors＋transport mapping 產生。
- **驗證／回復**：HTTP integration 驗證未登入／越權／CSRF／限流／未知欄位／日期；commerce API JSON 與 URL 回歸不變。完整 OpenAPI 生成若需套件，先查 Zod 3 相容性並保留單一 schema 來源。

### B04 — Queue／Outbox

- **讀取／ownership**：jobs、outbox、kernel worker／job-registry／event-delivery、SDK job facade、ops-module；主代理。
- **工作**：依 B00 選型補齊 F06／F10，定義 lease／heartbeat／fencing、timeout／abort、每類併發、payload version、取消／保留期／dedupe horizon 與安全重送；維持 enqueue 與 transaction 的原子性。
- **出口**：程序在 claim 後／副作用後中斷均可恢復；舊 owner 不能完成新 occurrence；非法 payload、移除訂閱與 unknown job 有明確處理，無靜默丟失。外部副作用的重複風險有驗證與記錄。
- **驗證／回復**：多 worker 真 DB 測試，replaceExisting／retryDead、completed 清理後去重、訂閱增減及既有付款／發票 job regression。若替換後端，演練 pending／running／dead 轉換與唯一 dispatcher 切換，對照前後 id／dedupe 清單；未換後端也要驗證前一版 payload 相容。

### B05 — Scheduler

- **讀取／ownership**：recurring、module jobs declaration、worker、config、相關 CLI／ops 註冊；主代理。
- **工作**：整合選定排程套件的 cron／timezone 計算，持久化 occurrence／pause／misfire／overlap 狀態，排程只 enqueue，由同一 worker 執行。
- **出口**：Asia/Taipei 午夜、具 DST 時區、停機補一次／有上限追補、多 worker、暫停／恢復可重現；原 everyMs 工作照常運作。
- **驗證／回復**：可控 clock 的運算測試＋PG 競爭測試；更新 ADR 0016，遷移舊排程時不得雙排或漏接。

### B06 — Mail

- **讀取／ownership**：新增 base mail 範圍、設定、SDK capability、jobs／storage 公開入口；主代理負責 transport 與授權，模板可由 implementer 單獨擁有。
- **工作**：Nodemailer SMTP、HTML／text 模板、多語、附件 stream、立即／queue send、穩定 message reference、accepted／rejected／unknown 診斷；模板版本與 job 一起可追溯。
- **出口**：非商務收件人可收信；模板 escaping、部分拒收、auth failure、timeout、附件不存在有明確結果；production 配置不可默默退到 mock。
- **驗證／回復**：本機 SMTP sink 驗證 MIME／附件／失敗與重試；授權 staging 收件人驗證 transport。SMTP accepted 不等於 delivered；依 reference 處理復原與重寄風險，保留舊 job 所需模板至處理完成。

### B07 — Notifications

- **讀取／ownership**：base notifications 新範圍、`commerce/notification`、mock-notification、既有 notification 查詢；主代理整合。既有 UI 僅作 consumer 參照，保持其 HTTP 契約；新增通知 UI 由 B13 擁有。
- **工作**：通用 recipient、template、channel、delivery record，正式 email＋站內收件匣／已讀能力；商務事件到模板的 mapping 留在 commerce。
- **出口**：HTTP／CLI 可讀取與標記自己的站內通知；通道個別失敗可重試、投遞紀錄遮蔽個資。既有訂單／物流通知與重送入口遷移後保留語意；本包完成後 F05 的新增營運 UI 仍待 B13，整體不可提前關閉。
- **驗證／回復**：兩通道整合及 order lifecycle 回歸；以 migration／job mapping 保留舊通知紀錄與去重 identity，不雙發新舊路徑。

### B08 — Identity 與安全閉環

- **讀取／ownership**：identity／authorization、auth HTTP、storefront reset、設定；主代理。Admin 新帳號管理／登入復原頁由 B13 擁有，本包先提供可測的 HTTP／CLI 流程並保持既有 UI consumer 相容。
- **工作**：讓前台身分不必建立 commerce Customer；完整 email verification／reset／change、停用／session 撤銷、token 到期／撤銷、resource policy、登入限流、高權限 MFA 與復原。
- **出口**：HTTP／CLI 的作者／操作者不帶商務 profile；Customer 仍由 commerce 擴充。帳號枚舉、重放 token、停用後存取及 MFA 復原有具體設計與防護；F04 的網站／Admin UI 在 B13 閉環。
- **驗證／回復**：真 HTTP＋DB 驗證與正式 mail 接線；token 建立與 enqueue 原子性、加密暫存／到期清理、queue delay 超過 TTL、改密碼撤銷舊 session、降權失效、token rotation 回歸。沿用現有 hash／session，先核對相容性，不全面換 auth framework；必要密碼學／MFA 使用成熟實作。

### B09 — Storage

- **讀取／ownership**：新 storage 範圍、HTTP upload／download、config、持久 data paths；主代理。
- **工作**：Fastify multipart＋fs／stream＋AWS SDK；統一物件 metadata／stream、讀寫／刪除／分頁列舉、public／private、短效 URL、limits、ownership、temporary cleanup；本機與 S3 兩個正式 adapter。
- **出口**：同一 contract suite 跑兩種 adapter；偽造 MIME、超大檔、路徑穿越／symlink、未授權下載、過期 URL、斷線上傳均有驗證；本機檔案不隨 release 替換而消失。
- **驗證／回復**：臨時目錄、本機 S3 相容測試服務＋授權 staging；bucket／key 不由任意使用者指定，URL／secret 不進 log。移轉檔案需 hash／size 對照及可重跑清單。

### B10 — Media 與圖片處理

- **讀取／ownership**：新增 media 模組、Storage／Jobs 公開入口、媒體 Admin 頁；主代理負責資料與 processing，UI 可委派。
- **工作**：Sharp 背景縮圖／轉檔、像素／尺寸／時間限制、上傳／處理／失敗狀態、alt text、引用計數或等效引用查詢、刪除／孤兒清理。
- **出口**：使用者可上傳與選圖、看見失敗並安全重試；被引用媒體不可無聲刪除；同一圖片重送不產生無限制衍生物。Theme 靜態裝飾資產與使用者媒體分清。
- **驗證／回復**：真圖片 pipeline＋權限／錯誤 UI、worker restart、Docker／native Sharp 載入；ADR 0034 的內容 image key 轉移契約交給 B14，同時列出舊資產保留與清理門檻。

### B11 — Cache 與互斥

- **讀取／ownership**：新 cache 範圍、db／config／生命周期、測試 helper；主代理。
- **工作**：評估並整合 Keyv PG adapter，namespace／TTL／delete／clear／cleanup；定義可用於跨程序的 lock 生命週期，優先 PostgreSQL 原生鎖，不用 cache get＋set 模擬原子鎖。
- **出口**：兩個 process 可觀察同一失效、過期後回源；模組不能 clear 別人的 namespace，provider outage 不使權威資料丟失。鎖的 timeout／owner／connection release 清楚。
- **驗證／回復**：PG TTL／失效／競爭測試；cache 可清空重建，lock 不能靠重啟猜測解除。金融帳本與安全狀態不遷入 cache。

### B12 — 共用工具

- **讀取／ownership**：既有 HTTP 呼叫、Admin i18n／Intl、identity/password、logger；新增共用入口由主代理，字典與純格式化可委派。
- **工作**：原生 fetch＋AbortSignal 的 timeout／response error／retry 規約、受信任目的地與 secret redaction；跨 SSR／mail／Admin 的 locale／message namespace／plural／fallback；日期序列化及時間工具；crypto 的 sign／verify／encrypt／rotation 使用方式。
- **出口**：網路錯誤、無效 JSON、timeout、取消及不安全 retry 有測試；外部 URL 不能透過 redirect 繞過存取限制；三語 fallback 與時區不改變既有金額／日期語意。
- **驗證／回復**：本機 HTTP fixture、純 message／date tests、crypto tamper／rotation tests；選一個實際 consumer 遷移，其他呼叫端按相同語意逐一收斂，不生第二套 fetch framework。

### B13 — 網站殼與模組頁面

- **讀取／ownership**：kernel theme、API storefront／AppModule、Admin routes／App、default theme、Spec 0008；主代理接線，獨立 UI 檔可委派。
- **工作**：把 commerce render types 留在 commerce，通用 Theme 以具型別的模組頁面能力組合 SSR／表單／靜態資產渲染；Admin 依有效模組與權限組裝 route／navigation；網站設定與導覽獨立於 Theme、視覺 options 依 Theme id 保存。接入 B07 的站內通知／已讀與投遞查詢、B08 的帳號／token 管理及登入／重設／MFA 復原頁。
- **出口**：簡單非商務頁可掛前台與後台；帳號管理、登入復原及通知可從 UI 完成，沒有僅存在 API 的交付缺口。直接進 URL 仍需後端授權，隱藏選單不是權限檢查；商務 Theme 缺必需頁面時被拒絕。
- **驗證／回復**：commerce-free HTTP／Admin、既有路由／theme regression、鍵盤與視覺檢查；版本化 Theme contract，保留內容／URL／導覽與設定，僅專屬視覺設定可重新配置。

### B14 — 內容／Blog 與品牌媒體遷移

- **讀取／ownership**：`commerce/content`、brand/contact API、Theme article types、Admin content 頁、seed；主代理，依確定契約派 UI。
- **工作**：將內容／聯絡功能獨立為網站模組，保留已發布 slug／資料 id；補齊 F14；舊 Theme image key 映射為 media reference，透過 B09／B10 匯入原始資產。
- **出口**：形象站與 Blog 發布流程不建立 Customer／order；草稿、權限、分頁、RSS／sitemap、換 Theme 的內容與照片保留。聯絡表單可按網站設定透過 B07 通知，原收件匣流程保留。
- **驗證／回復**：內容／contact 回歸、XSS／未發布資料隔離、舊 DB＋照片 backfill 可重跑且有比對；migration history 不重置，未映射資料阻擋 contract 階段而非默默丟圖。

### B15 — 維運與升級

- **讀取／ownership**：CLI、deployments、build／release／smoke、logger／health、operations／runbooks；主代理，文件可委派。
- **工作**：已啟用能力的診斷、queue／scheduler／mail／storage 指標與告警入口；DB＋媒體備份／復原；API／Worker 版本相容檢查、設定／secret rotation、release migrations。
- **出口**：從乾淨機器照文件部署與啟動；故障可定位；從前一版完整資料與 jobs 升級／回復演練。CPU 圖片處理與 API 工作資源分隔；非啟用能力不要求額外服務。
- **驗證／回復**：既有 Docker／native smoke 加新服務與 volume persistence；實測復原資料／物件 hashes 及未完成 jobs。SMTP／S3 真實環境尚未驗證時列 release gate，不能自稱 production-ready。

### B16 — 可照做的模組範例

- **讀取／ownership**：extension-sdk、module 公開入口、docs/extension-development、新非商務範例及 tests；主代理。
- **工作**：受審核、自己擁有資料表的「檔案處理申請」模組：前台授權上傳、後台查詢／處理、Job、Mail／站內通知、Cache、排程清理；透過正式公開入口接入。
- **出口**：新接手者依文件只新增模組及站點組裝，不改 base；附完整 migration／permission／routes／job／template 宣告及同一介面的測試 helper。
- **驗證／回復**：跑通成功、重啟重試、非法依賴／版本／權限；掃描 runtime／browser 依賴未跨層。清理範例資料有明確目標且不影響其他模組。

### B17 — 整體驗收與交付

- **讀取／ownership**：Spec 0009 §8、各包完成證據、整合測試／smoke／交付文件；主代理與 Sol 獨立審查。
- **工作**：同一版本 build 三種網站、兩個 Theme、非商務模組與跨版本資料；逐項追蹤 F01–F16 到實作、測試及文件，依 B00 相容矩陣回歸全部公開入口及 payload，達成退場條件才移除已無 consumer 的舊路徑。
- **出口**：所有技術驗收有可重跑證據；外部 UAT／正式開通分開列結果，未通過不得關閉相應 release gate。實際下一案重用工時屬持續產品驗證，不偽造量測。
- **驗證／回復**：全套 CI、雙部署 smoke、staging transport、升級與回復；列出精確 release／base／module／schema 版本及 remaining risks。對外發布依當時授權。

## 5. Spec 0008 的銜接

現有 [Admin 交接](admin-implementation-handoff.md) 與 Ticket 81–91 保留。先核對
`1f4470d` 是否滿足 Ticket 81 的驗收與實際測試，不能根據文件的「尚未實作」重做。

預設先完成 Spec 0008 中會寫 B13 共用檔案的票：82–83 primitives、86 shell、87–89 Query／身分快取
及其表列前置，最後 90 closure；若其中已完成，直接引用證據。
B00–B12 的後端工作不必等完整 Admin UI 才能開始，但避開 Admin 共享檔案；
若要提早做 B13，先將衝突票 ownership／順序具體重排到本計畫，再派 writer。
新媒體／帳號／通知頁接入 B13 之後的殼，沿用已有 primitives／Query，避免建立第二套。

## 6. 共用驗證與交付格式

實作票先跑所影響的最低有用層，再完成相關 repository checks：

- 平台：`pnpm typecheck`、`pnpm test`；DB／HTTP／Queue／Storage 真整合使用 `pnpm test:integration`。
- Admin：`pnpm typecheck:admin`、`pnpm test:admin`、`pnpm build:admin`；涉及互動時補真實瀏覽器鍵盤／視覺檢查。
- 接線／release：`pnpm build`；最終依 `.github/workflows/ci.yml` 執行 `pnpm smoke:docker`、`pnpm smoke:native`。
- Testcontainers／Docker 與外部 SMTP／S3 有環境前置，使用隔離測試資料；缺環境如實標示，不把它解讀為測試通過。
- 本輪規劃文件只做 whitespace、Markdown 本機連結、能力／工作包覆蓋與 DAG 無循環檢查，不為文件修改重跑整套應用測試。

每次交付記錄：工作包／切片、HEAD、owner 與檔案、實際選用版本、完成的 F 項、
passed／failed／not-run checks、審查與修正、migration／rollback 結果、剩餘 blocker、下一個可派工包。

跨 session 接手時，使用 §3.1 的派工單格式，先指定 A／B／C 與分析或實作模式；目前入口是 B05 排程線與 B09 Storage，不再使用歷史 B00 接手指令。

## 7. 本輪規劃交付紀錄（2026-09-06）

- 完成 source inventory、官方套件方向查證、Sol／high 架構分析及獨立規劃審查。
- 審查修正：已停用模組的 migration 歷史、簽章／Storage 相依、帳號／通知 UI ownership、
  明確 Ticket 90 前置、M2／M3 順序、全部 public surfaces 相容矩陣，以及 Ticket 81 的既有實作狀態。
- Sol／high 複查：沒有剩餘的重大規劃 blocker；不代表 runtime 已完成或通過 production 驗收。
- 文件檢查通過：8 個本輪編輯文件、141 個本機連結、F01–F16 owner 覆蓋、B00–B17 派工卡、
  DAG 無循環、Ticket 90 外部前置明確，以及 `git diff --check`。
- 未執行應用測試、套件 PoC、外部 transport 或部署驗證：本輪只改規劃文件，這些由對應工作包執行。
- 未安裝依賴、修改程式、commit／push 或發布工單；下一個入口為 B00。
