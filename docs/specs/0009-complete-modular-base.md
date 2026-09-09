# Spec 0009 — 完整應用基底與模組化建站

- 日期：2026-09-06；程式盤點基準：`1f4470d`。
- 狀態：in-progress；2026-09-07 B00 研究、隔離 PoC 與 B01 模組契約均已通過驗證與獨立 Sol 雙軸審查；B02 release／history 契約已完成分析，共用設定／角色／bootstrap 實作中，B02–B17 尚未結案。
- 派工入口：[Base 執行計畫](../base-implementation-plan.md)。該文件管理工作包、相依與接手；本文件是能力與驗收的唯一規格來源。
- 使用者已授權依序交付完整 Base；目前僅修改本機程式並執行隔離驗證；未變更正式站點，未授權 GitHub 寫入或部署。

## 1. 產品目標與完成定義

StoreWeave 是供團隊交付與維護客製網站的模組化基底，先服務台灣單一商家的品牌購物站，
再以同版本的形象站與 Blog 驗證通用性。商品化先從建站與維護服務開始；價值是重用已驗證功能、
保留品牌與流程客製空間，並讓各站持續升級共用基底。

Base 必須達到 Laravel／AdonisJS 類型的基礎服務完整度。分階段只表示交付順序，
不縮減下方能力矩陣。可整合成熟套件；套件本身能做，不等於 StoreWeave 已提供。

每項能力完成都要有：

1. 可用的正式 implementation、公開 interface、設定及必要的 migration。
2. 成功、輸入錯誤、授權拒絕及相關故障情境的行為驗證。
3. 同一 interface 的測試工具與完整使用範例，不能只有 stub、mock 或未接線的型別。
4. 啟動、停止、健康檢查、升級與復原說明；有背景或外部服務時提供診斷方式。
5. 至少一個實際呼叫端；通用能力可由非電商驗證模組使用，不能只能從訂單流程呼叫。

「完整」以本矩陣為交付邊界，不等於逐一複製參考框架的所有生態產品。
後台動態安裝、第三方市集、任意頁面編排跨主題無損搬移仍按已確認定位暫緩；
這些不替代或抵銷任何基礎能力。

## 2. 組成與責任

| 組成 | 責任 | 可依賴 |
| --- | --- | --- |
| 應用基礎 | HTTP、DB、Identity、Jobs、Mail、Storage、Cache、Events、設定、日誌、CLI | 既有 framework、stdlib、選定基礎套件；不依賴電商 |
| 網站共用功能 | Admin 外殼、網站設定、導覽、內容／Blog、媒體管理、Theme 掛載 | 應用基礎及明確宣告的網站模組 |
| 業務模組 | 商品、訂單、促銷、會員等級、付款／物流等 | 基礎能力與其他模組的公開 interface |
| 站點組裝 | 選取模組、Theme、設定與 provider；產生版本化 release | 上述已發布入口；個別客製留在該站模組／Theme |

每站獨立部署及資料庫，API／Worker／CLI 使用同一個 release 與有效模組圖。
採 build-time 組裝，修改組裝設定與重新部署是正常流程；一般擴充不修改核心內部。
新形象站的乾淨資料庫不得建立 commerce 資料表，也不得要求電商設定、掛載商務 API 或顯示商務選單。
已有商務資料的網站移除模組時，保留資料並先檢查相依與待處理工作，不自動 DROP TABLE。
有效 runtime 模組圖與 migration 歷史清單分開：已停用模組保留 module id／版本／migration id／checksum
的唯讀歷史 metadata，供已存在的資料庫校驗，不因此在新站執行其 migration 或載入其 runtime。
重新啟用時先驗證保存資料與目標版本，執行必要的向前遷移；未知或被竄改的歷史仍拒絕啟動。

保留 NestJS／Fastify、Drizzle／PostgreSQL、React／Vite、Command／Query 與 Outbox 的已驗證投資。
Laravel／AdonisJS 是完整度參考，本規格不要求遷移 framework。HTTP、SSR、Admin、CLI、MCP
仍沿用受授權的應用入口；健康探測與靜態資源等平台傳輸責任不強迫繞行商務 Bus。

## 3. 完整能力矩陣

「部分」表示有程式基礎，未代表下列驗收已達成；工作包編號見執行計畫。

| ID | 能力與完整交付範圍 | 現況／主要證據 | 工作包 |
| --- | --- | --- | --- |
| F01 | 啟停、DI／服務註冊、環境設定驗證、secret 引用、模組相依及版本、每程序一致的組裝結果 | 部分：`kernel/src/runtime.ts`、`bundle/src/bootstrap.ts`、`config/src/schema.ts` | B01–B02 |
| F02 | HTTP 路由／中介層、body／query 驗證、JSON／日期契約、錯誤 envelope、分頁、CORS／CSRF／限流、API 文件 | 部分：`apps/api/src`、`contracts`；meta schema 不等於完整 HTTP 文件 | B03 |
| F03 | DB pool、query／transaction、migration／seed、順序與校驗、升級前檢查、backup／restore | 部分：`db/src/migrator.ts`、CLI；需依有效模組選取及升級驗證 | B01–B02、B15 |
| F04 | 帳號、登入／登出、session 撤銷、密碼重設／驗證信、角色／resource policy、停用帳號、可撤銷及到期的 service token、登入防暴力嘗試 | 部分：B08 已交付簽發式重設／驗證／換信箱、資料庫 API token、後台 MFA、停用與登入鎖定、帶資源的 policy；HTTP／CLI 齊備，網站與 Admin UI 待 B13 | B03、B08、B13 |
| F05 | 通用 Mail：HTML／text 模板、收件人、附件、SMTP 正式 transport、排隊寄送、失敗分類／紀錄／人工處置、測試 transport；Notification：email 與站內通知、通道擴充 | 部分：`commerce/notification`、`extensions/mock-notification`；現有契約仍帶商務語意 | B06–B08、B13 |
| F06 | 持久 Queue、worker、延遲工作、型別化 payload、重試／退避、逾時／取消訊號、lease／crash recovery、併發與工作隔離、DLQ／重送、保留期及監控 | 部分：`jobs/src/jobs.ts`、`kernel/src/worker.ts`；完整失敗語意需驗證 | B04 |
| F07 | 固定間隔及 cron、時區／DST、錯過排程的 skip／補一次／有上限追補、防重疊、暫停／恢復、可查詢的執行結果 | 部分：`kernel/src/recurring.ts` 只有 everyMs time bucket | B05 |
| F08 | Storage：串流上傳／下載、metadata、刪除／列舉、本機與 S3 相容儲存、公開／私有存取、短效 URL、限制與中斷清理、測試 adapter | 缺通用實作：目前主要是 `apps/api/src/theme-assets.ts` 的 release 靜態資產 | B09 |
| F09 | 媒體管理：上傳／選取／替代文字、圖片驗證／縮圖／轉檔、背景處理狀態、引用與刪除規則；使用者媒體不依附 Theme release | 缺：ADR 0034 明定 Theme image key，需資料遷移 | B10 |
| F10 | 版本化事件、訂閱驗證、transactional outbox、可靠 fan-out、重試與冪等、訂閱變更／移除的待投遞處理 | 部分：`event-bus`、`outbox`、`kernel/src/event-delivery.ts` | B01、B04 |
| F11 | Cache get／set／delete／TTL、命名空間、失效規則、共享儲存與測試替身；互斥鎖具有持有者及生命週期，不以普通 cache set 模擬 | 缺通用 cache；不把 Spec 0008 的瀏覽器 Query cache 當成 server cache | B11 |
| F12 | 外部 HTTP 的 timeout／abort／錯誤分類／安全重試，可信目的地；locale／翻譯／plural／fallback、日期／時區、HTML escaping；安全 random／hash／sign／encrypt 與 key 輪替約定 | 部分：原生 fetch、Admin 字典、Intl、identity/password；需共用使用規範與接線 | B03、B12 |
| F13 | 網站設定、導覽、Theme／頁面契約、SSR／表單／靜態資產、Admin 頁面／選單／權限掛載；內容、URL、設定換 Theme 後保留 | 部分：`kernel/src/theme.ts` 強制 commerce render methods，Admin routes 固定 | B13–B14 |
| F14 | 形象內容及 Blog：獨立發布、草稿不可公開、slug／網址、清單／文章／分頁、導覽與媒體；title／description、canonical、sitemap／robots、RSS 的基本發布能力 | 部分：`commerce/content` 已有 brand articles／contact；需脫離 commerce 與主題圖片 key | B14 |
| F15 | 模組 SDK／範例、CLI 註冊與診斷、API 使用文件、測試 helper、契約與跨版本檢查、依賴及授權清單、可重現 build | 部分：`extension-sdk`、`tools/cli`、Vitest／Testcontainers；尚缺完整獨立模組流程 | B01–B03、B16 |
| F16 | 結構化 log／redaction／trace ID、audit、readiness／liveness、worker／queue／storage／mail 診斷、metrics／告警指引、部署、升級及 DB＋檔案一致復原 | 部分：Pino、health、CLI 與 deployment scripts；需涵蓋新增服務 | B04–B12、B15、B17 |

上述新建網站發布功能是針對形象站／Blog 的具體規劃，不擴及廣告投放、SEO 顧問或推薦系統。
站內通知是本規劃建議的第二個正式通道；SMS／推播等可由同一契約新增，不要求首版整合每家供應商。
高權限帳號的 MFA／復原方案列入 B08 的安全設計與交付，採現成實作，不能以自製密碼學補足。
（已交付：TOTP 走 otplib，復原碼為一次性隨機值，見 ADR 0044。）

## 4. 擴充契約

組裝入口採版本化 release definition：記錄 base／release 版本、模組圖、產品設定、角色 policy、
Theme、HTTP／Admin adapters 與 assets。領域模組維持明確 constructor injection，
transport contribution 由 release adapter 組合，避免把 Nest controllers、React 或 service locator 塞進領域介面。

目前 `PlatformModule` 可帶 migration 與 handler，`ExtensionContext` 只提供受限 SDK／KV，
兩者權限不同。新增有自己資料表的「活動報名」模組應使用受審核的模組入口，
不是把任意 DB／tx 注入現有 ExtensionContext。

公開 interface 必須說明的不只有 TypeScript 型別，還包含：

- 模組 id／版本、base 相容版本、required／optional dependencies、輸入設定、secret 與能力宣告。
- 資料所有權、migration 順序、公開 transaction-aware 操作的原子性、事件／job payload 版本。
- HTTP／前台頁面／Admin 頁面與權限貢獻；衝突、循環依賴、缺少必要能力在啟動前失敗。
- 對 Mail／Jobs／Storage／Cache 的可用存取範圍、資源命名空間、限額及錯誤語意。
- 停用／升級時對既有資料、未完成 jobs、事件訂閱、模板與媒體引用的處理。
- 可重用 contract tests，以及新增模組只修改模組與站點組裝檔的 runnable example。

Theme 以具型別的模組能力組合：基礎頁面加上 content／commerce 等 renderer，由各模組擁有資料投影。
不把所有商務 render 方法改為 optional 就當作拆分完成。共用網站設定獨立於 Theme，
各 Theme 的視覺 options 以 Theme id 隔離，停用仍保留；切換主題不執行內容資料遷移。

同程序安裝的 Node.js 模組是受信任程式碼。SDK 約束、imports 檢查、資源授權
是工程與應用存取限制，不能宣稱可隔離惡意第三方程式碼；不可信插件執行沙箱另案。
第三方 package 的型別可在單一 implementation 內直接使用；只有跨模組需穩定的語意才由 base 擁有契約，
不為每個套件機械新增一層 wrapper。

## 5. 套件整合策略

2026-09-06 查閱下列官方來源；這是選用方向，沒有完成安裝、相容性 PoC 或依賴安全審查。
每張接入票鎖定實際版本、license／transitive dependencies、Node／Fastify 相容性及 release 打包證據。

| 能力 | 方向 | 選用與驗證條件 |
| --- | --- | --- |
| HTTP／DI／DB／驗證／日誌／CLI／測試 | 沿用 NestJS、Fastify、Drizzle、pg、Zod、Pino、Commander、Vitest／Testcontainers | 不因基底改名重建 framework、ORM 或測試框架 |
| Mail | [Nodemailer](https://nodemailer.com/) 的 SMTP 與測試 transport；模板候選 [Handlebars](https://handlebarsjs.com/guide/) | 處理部分收件人失敗、TLS、模板 escaping、附件 stream；模板由受信任 release 提供 |
| Jobs／Scheduler | 既有 PG jobs 對照 [pg-boss](https://pgboss.io/)；cron 解析可用 [cron-parser](https://harrisiirak.github.io/cron-parser/) | B00 必須比較 transaction enqueue、replaceExisting、DLQ、lease、排程與遷移成本，再選單一實作。排程不能只靠行程內 timer |
| 上傳／儲存 | [Fastify multipart](https://github.com/fastify/fastify-multipart)、Node fs／stream、[AWS SDK v3 S3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html) | 避免把整個檔案讀進 RAM；測試大小限制、斷線清理、private URL、S3 相容服務的實際行為 |
| 圖片 | [Sharp](https://sharp.pixelplumbing.com/) | 尺寸／像素／處理時間限制；驗證 Docker 及 native release 的 native binary 打包 |
| Cache | [Keyv](https://keyv.org/) 與 [PostgreSQL adapter](https://keyv.org/docs/storage-adapters/postgres/) 作為首選評估 | 驗證 TTL、namespace、清理及 migration ownership；production 共用快取不能默認為各 process 的 Map |
| HTTP／時間／密碼學 | Node fetch／AbortSignal、Intl、node:crypto | 沿用 repo Node 22 工具鏈支援範圍；有外部副作用的 POST 不盲目自動重試 |
| 翻譯 | 先沿用現有字典與 Intl；B12 評估是否需成熟訊息格式套件補 plural／fallback | 保留既有三語 key；不要求為選用框架重翻全部 UI |
| Admin | 沿用 Spec 0008 的 shadcn/ui 與 TanStack Query 方向 | 先核對實際落地狀態，再加入模組掛載；server cache 不與 Query 混用 |

PostgreSQL 維持預設必要基礎設施，寄信配置 SMTP、檔案可選本機或物件儲存。
不因 Queue／Cache 就預設新增 Redis；若比較證明必須採用額外服務，先在該工作包記錄效益、
部署成本與復原策略，不能透過套件 default 靜默改變部署要求。
套件的「exactly once」宣傳不能當作外部副作用保證：SMTP 接受後回應遺失仍可能造成重寄。

## 6. 關鍵故障與資料語意

| 情境 | 要求 |
| --- | --- |
| 啟動中途失敗／SIGTERM | readiness 維持 false，已開啟資源逆序關閉；停止 intake、限時 drain jobs，再關閉 adapters／DB。重複 shutdown 必須安全 |
| migration 與 release 不符 | checksum 漂移、已套用歷史無法由有效或已停用模組的歷史清單辨識、同模組重複／非單調 id 或相依順序錯誤皆在啟動前拒絕；跨模組順序由模組圖決定，不能字串排序猜測 |
| DB rollback／commit 後程序死亡 | 交易內 enqueue／outbox 與業務資料一起提交；不能先寄信再提交 DB |
| worker timeout、lease 到期或人工重送 | 明確 at-least-once 語意；持有者 fencing／heartbeat、有限重試；舊 worker 不能覆寫新執行狀態；副作用由穩定 reference 或領域冪等保護 |
| job 保留期／版本切換 | payload 帶 schema／版本，新 release 能處理或遷移前一版 pending／running／dead；清理 completed rows 前定義 dedupe horizon／tombstone，不能意外讓舊 key 可再次執行。取消是 cooperative abort，不保證撤回副作用 |
| 新增／移除事件訂閱者 | 明定 pending outbox 是否投遞給新增訂閱者；有待投遞 jobs 的移除須先 drain／遷移／明確終止，保留處置證據。不能按新清單無聲漏發 |
| Mail 被 SMTP 接受 | 記 accepted，不推定已送達收件匣；部分失敗及結果未知可查，不能重送所有已成功收件人；無供應商冪等時揭露重寄風險 |
| 密碼重設／驗證信排隊 | token 狀態與 enqueue 同交易；可重放的 token／URL 不以明文放一般 job／audit／log。使用受限加密 payload／reference、key ring 與到期清理；排隊超過 token TTL 的處理及重新申請流程有測試 |
| 檔案上傳中斷／處理失敗 | 限額及路徑保護，temporary／processing／ready／failed 狀態可觀察；孤兒檔與 DB metadata 有可重跑清理規則 |
| 私有檔案與通知 | 驗證資源擁有者／權限；簽章 URL 短效且綁定資源；log／audit 遮蔽 token、郵件內容與個資 |
| 排程跨 DST／停機 | 定義 occurrence key、時區與 misfire policy；補跑有上限，多 worker 只有一份有效排程實例 |
| Cache 過期或服務失敗 | 可從權威資料重建；不做帳本、session 撤銷或安全決策的唯一來源；跨 process 失效可驗證。Lock 是獨立能力，與 Keyv Cache 的失敗／釋放語意分開 |
| 外部 HTTP timeout | 區分拒絕與結果未知；副作用操作依 provider 冪等與查詢契約處理，不以換 key 重試 |
| 移除模組或不相容升級 | 先檢查反向依賴、待執行工作、資料版本及頁面／主題需求；提供診斷，不能靜默略過工作或自動刪資料 |

## 7. 既有規劃、遷移與回復

- Spec 0008 繼續擁有後台 UI／Query 遷移；本規格擁有模組化殼與新增基礎能力。兩者共享檔案由執行計畫排他安排。
- Ticket 81 的相關實作已見於 `1f4470d fix(admin): align order HTTP contract`；舊交接稱全部未實作，派工時須重新核對驗收，不能據舊狀態重做或宣稱測試通過。
- Ticket 91／ForgeFlowv2 仍待來源與用途；不作 Queue、Scheduler 或其他完整能力的必要前置。
- ADR 0010 的領域中立保留，通用殼暫緩條款由 B02／B13 落地後更新；ADR 0016 的排程限制由 B05 更新；ADR 0034 的 Theme-owned media 由 B10／B14 完成遷移後取代。
- 保留現有公開 Command／Query／Event／Job 名稱與 payload、MCP tool、Extension bridge 路徑、SDK export、設定鍵、CLI 命令及 HTTP 契約。新增 base 契約有自己的版本，不藉搬目錄改掉商店公開 API。
- B00 建立「既有識別／owner → 新 owner／識別 → consumer → 相容方式／退場條件」清單。B07／B14 搬模組仍維持 commerce release 的舊入口；非電商新入口不要求載入舊 commerce runtime。確需更名才建立有期限 adapter，B17 驗證所有列出的 public surfaces。
- migration 名稱／歷史不得因模組搬家重置。先列出受影響部署與 schema/job/template 版本，採 expand → backfill → 切換 → 驗證 → contract，確有轉換需要才保留有期限的相容路徑。
- contract 階段的不可逆刪除需列出精確目標、完成備份及相容性檢查，再取得執行該刪除的授權；一般啟動不可自動執行。舊 migration 增補 checksum 有明確基準建立流程，不假裝舊歷史原本就有校驗。
- 更換 Queue 實作時必須處理 pending／running／dead、原始 id／dedupe identity、outbox 原子性與人工重送；同一工作只能由一套 dispatcher 接管。
- 使用者媒體放持久 data volume／bucket，不放 release 目錄。升級與 rollback 同時考慮 DB、媒體 manifest、模板及未執行工作。
- backup 復原要說明寫入暫停或一致快照策略，並實際驗證檔案與資料列引用。已寄出的信件等外部副作用不可由 DB restore 撤回，復原前需對帳及選擇重放範圍。
- 不能回讀新 schema 的舊 binary 不可直接 rollback；停止寫入後依已演練 backup 復原或向前修復，不用破壞性 reset 解決。

## 8. 最終驗收

- [ ] F01–F16 每項都有正式 implementation、文件、故障測試與使用範例；任何未完成項目都使完整 base 保持未完成。
- [ ] 同一 base 版本組出購物站、形象站、Blog。無電商組裝在乾淨 DB 無商務表、API、選單及必要設定，打包後也不載入 commerce runtime。
- [ ] 更換兩個主題後，內容、媒體、URL、導覽及功能設定保留；主題專屬視覺可重設，購物站必需的頁面能力缺失在建置／啟動時被拒絕。
- [ ] 一個有自己資料及前後台頁面的非電商模組，跑通「授權上傳 → 排 job → 背景處理 → 狀態查詢 → 寄信／站內通知」；worker 重啟與授權拒絕有驗證。
- [ ] 新模組只修改模組及站點組裝宣告；模組契約測試驗證 missing dependency、版本不符、權限與命名衝突。
- [ ] 既有購物流程、資料、事件、外部整合及 Admin 行為通過回歸；商家 UAT／正式服務設定與程式測試分開記錄，不能以 mock 取代。
- [ ] 前一版資料＋排隊工作＋媒體能升級到新版，回復演練可重現；API／Worker 版本不一致可檢出。
- [ ] 完成既有 CI、Docker／native release smoke、私有媒體與真實 transport 的 staging 驗證；尚缺外部環境則列 release gate 未完成。
- [ ] 下一個真實案子記錄共用／客製範圍、客製工時與升級成本，作為商品化價值的後續驗證，與技術驗收分別報告。

## 9. 參考與證據使用

完整度參照：[Laravel](https://laravel.com/framework/docs/13.x)、[AdonisJS](https://docs.adonisjs.com/introduction)。
Queue／Mail／Storage 行為參照：[Laravel Queues](https://laravel.com/framework/docs/13.x/queues)、
[Mail](https://laravel.com/framework/docs/13.x/mail)、[Filesystem](https://laravel.com/framework/docs/13.x/filesystem)。
選型來源集中在 §5，實作票需按當時版本重新驗證，不將「有文件」當作相容性測試。

現況根據 source inspection，不是本輪執行結果。`docs/operations.md` 對密碼重設的描述
與 `identity/src/auth-service.ts`／Storefront reset 路徑曾經存在落差；B08 已核對後台、前台
與正式寄信狀態並更新該文件，重設信現在由 `@storeweave/mail` 寄出。
