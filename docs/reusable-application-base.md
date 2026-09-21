# 通用應用基底與產品分工

- 日期：2026-09-10
- 狀態：架構方向已確認；Base 工程實作已由 Spec 0009 B00–B17 完成。Base／Commerce 組裝與非商務範例提供可復用性證據，但跨產品的完整驗證仍隨未來產品追蹤。
- 本次交付：記錄概念、責任與完成標準，未變更程式或部署。

## 目標

將能跨應用共用的元件與工具整理成通用應用基底，讓之後開發 Commerce、ERP、CMS、
預約系統或內部工具時，都能選用同一套基礎能力。Commerce 是第一個使用這套基底的產品。

共用範圍涵蓋後端、前端、開發工具與維運流程。像 `tools/cli` 這類工具，也應有清楚的
共用入口，讓其他產品能直接使用既有的 migration、診斷、備份還原與服務管理能力。

「可共用」表示應用可以依需求選用，並帶入自己的資料、規則與呈現；每個應用只需載入
自己需要的能力及其必要相依。基底可隨實際需求演進，但新增產品不應要求在共用程式裡
增加產品名稱判斷，或複製一套基底自行維護。

## 責任分工

| 層級 | 擁有的責任 | 由產品提供的差異 |
| --- | --- | --- |
| 後端基礎 | Runtime、設定載入、DB、交易、migration、Command／Query、事件、背景工作、排程、認證、授權、檔案、快取、寄信、通知、日誌與稽核 | 業務資料、命令、查詢、事件、工作、角色權限與通知內容 |
| 前端共用能力 | UI 元件、登入、後台外殼、導覽與頁面掛載、表單、查詢狀態、錯誤與操作結果處理 | 產品頁面、欄位、流程、選單、品牌與版型 |
| 開發與維運工具 | CLI、建置、打包、部署流程、服務啟停、健康診斷、備份還原、升級與測試工具 | Release 身分、入口、設定範本、部署預設、seed 與產品專屬命令 |
| 業務模組 | 各自的資料表、規則、流程與公開契約 | Commerce 的商品／訂單／促銷；ERP 的採購／會計／製造等 |
| 產品組裝 | 選取需要的共用能力及業務模組，組成可執行、可交付的 Release | 每個產品自己的模組清單、設定、角色、HTTP／Admin 頁面、Theme 與整合選擇 |

網站設定、公開前台、內容發布與 Theme 等能力可以成為可選的共用模組。
只有後台或 API 的應用，不必為了使用基底而載入商店前台或建立商務資料。

## 依賴與共用原則

產品組裝依賴業務模組與共用能力；業務模組依賴共用能力，以及明確宣告的其他模組公開入口。
共用能力不得反向匯入產品組裝或特定產品的業務實作。

共用的判斷以責任與行為為準。例如表格、分頁與查詢狀態可以共用，訂單清單的欄位與操作
屬於 Commerce；權限檢查機制可以共用，採購簽核的角色與規則屬於 ERP。
Commerce 與 ERP 都有「庫存」，仍須先確認其資料與操作語意是否相同，才能決定是否共用。

共用介面應封裝可重用的行為，讓呼叫端只需提供必要的差異。已有成熟實作就沿用；
抽離時以實際呼叫端驗證，不為尚未出現的需求預先建立大量抽象或選項。

可復用性也包含套件入口、相依宣告、測試工具、使用說明與版本相容性。
其他產品應透過公開入口使用能力，不能依靠深層原始碼路徑或未宣告的根目錄相依才能運作。
共用能力的修正應集中維護，使用它的產品可透過升級取得修正。

## CLI、建置與部署的具體分界

共用 CLI 擁有 `migrate`、`doctor`、備份還原、升級與服務啟停的執行流程及校驗。
產品提供自己的 Release 身分、命令名稱、設定位置、服務識別與必要的擴充命令。
產品專屬的舊版相容處理由該產品擁有，透過明確入口接入共用流程。

建置與部署工具讀取產品組裝資料，選取入口、資產與部署設定。
新增 ERP 時應新增 ERP 的組裝資料，沿用同一套引擎；共用工具不應列舉
`base`、`commerce`、`erp` 來決定各產品的業務行為。

產品識別可擴充不代表放寬校驗。Release、版本、manifest、備份來源與目標仍須一致，
不能因為支援新產品而允許錯誤的升級或跨產品還原。

## 與目前專案的關係

目前的共用 Runtime 與 Base／Commerce 組裝已由 B00–B17 驗證；下表說明已實作的責任分工，
不是僅因為已有 `packages/platform` 目錄而推論未來每種產品都已完成驗證：

| 目前位置 | 已區分的責任 |
| --- | --- |
| `packages/platform/release` | 共用 Release 契約、bootstrap、manifest 與 target contract checks；產品組裝分別位於 `packages/releases/*` |
| `packages/platform/config`、`authorization` | 共用設定與授權機制，以及產品設定預設和角色權限清單 |
| `apps/api`、`apps/admin` | 共用 HTTP／Admin 能力，以及 Commerce 的路由、頁面與操作 |
| `tools/cli` | 共用維運流程，以及產品名稱、路徑、Release 限制與舊版相容處理 |
| `scripts`、`deployments`、Docker 相關檔案 | 共用建置部署機制，以及產品入口、資產與部署範本 |

本文件確認責任分工，不預先固定搬移後的目錄名稱、套件發布方式或 repository 拆分方式。
已完成的實作同時處理實際依賴、公開入口與建置產物；只搬檔案或隱藏選單不代表完成隔離。

## 可復用性的完成標準

以下是跨產品可復用性的驗收目標。[Spec 0009](specs/0009-complete-modular-base.md) 的 B00–B17 與
[B17 驗收矩陣](base/b17/acceptance.md)記錄了 Base 工程、Base／Commerce 組裝與非商務範例的證據，
但不代替特定環境的 release readiness、真實案件的產品驗證，或每種未來產品的完整驗證：

1. 不載入 Commerce 時，共用基底仍能獨立建置、啟動並使用所選能力。
2. 新增非商務應用時，只新增其業務模組、產品組裝與必要資產，不修改共用程式來辨識該產品。
3. 非商務應用能透過相同公開入口使用 HTTP、認證、授權、資料操作、背景工作及所需 UI 元件。
4. 同一套 CLI 與工具能完成該應用的建置、migration、診斷、備份還原與相容版本升級。
5. 乾淨的非商務應用資料庫不建立 Commerce 資料表，後端與瀏覽器產物不包含未選用的商務實作。
6. 獨立使用範例能透過共用套件的公開入口運作，不依賴 Commerce 專案的隱藏設定或原始碼路徑。
7. 共用能力有契約、測試與升級說明；Commerce 既有功能與資料相容性通過回歸驗證。

## 第二產品的驗證方向：Booking

下一個跨產品驗證以一個實際的住宿預訂 Product Release 為準，不先設計抽象的多產品模板。Booking 與
Commerce 分開建置、部署並使用獨立資料庫；它沿用 Platform 與適用的 Base Module，以自己的 Product Module
表達住宿供應、價格、訂房與政策。第一版以房型數量表示可售供應，數量為一時也能涵蓋整棟或單一房間出租；
實體房號分配不屬於第一版。

第一個驗證切片須走完搜尋日期與人數、查詢可售房型、取得價格與政策、暫時保留房晚、建立訂房、付款或
延後付款、確認、取消並釋放房晚，以及後台管理房型、價格、供應量與訂房。OTA／Channel Manager、動態定價、
清潔排班、門鎖、餐飲與會計留待有實際需求時另行決定。

第一版一個 Release 只啟用一個 Property，但 Property 仍是地址、時區、入住時間與政策的正式擁有者。
一筆 Reservation 只包含一個 Room Type、一段連續日期與該房型一個或多個可售單位；不同房型分開建立 Reservation。
Booker 不必登入，聯絡資料以 Reservation 快照保存，並可選擇連到 Account；Guest 與 Booker、Account 都是
不同概念。

Booking Quote 不占房晚。建立 `pending_payment` Reservation 時才在同一交易內檢查並占用 Room Night，
同時凍結逐晚含稅價格、幣別、總額與取消政策；Reservation 確認前若到期則轉為 `expired` 並釋放房晚。
第一版價格來自 Room Type 的基本每晚價格與指定日期覆寫，人數只驗證每房最大入住人數。取消只支援整筆處理，退款
截止時間前可全額退款，截止後交由營運者處理。

產品能力不因名稱相似就移入 Base。只有當 Commerce 與 Booking 對該能力的領域語意、生命週期與公開契約
確實一致，且已有兩個實際呼叫端時，才把它提升為 Base Module；在證據出現前，產品模組可以保留各自實作。
這項規則特別適用於付款、發票、顧客／住客、促銷與庫存等表面相似但常有不同不變條件的概念。
Booking 可以重用領域中立的 Payment Provider adapter，但付款嘗試、Reservation 狀態轉換與付款成功後效果
由 Booking 擁有。現有 Provider 契約中的 Order 名稱須先中立化；在兩個產品的持久化模型與生命週期證明一致前，
不建立共用 Payment Module。

Booking 的第一組 Product Module 是 `booking-property`、`booking-availability` 與 `booking-reservation`。
Property 擁有房型名稱、每房最大入住人數、床型、設施、入住限制與 Media reference；Availability 擁有逐日可售數量、
價格、Quote 與 Room Night 的占用／釋放；Reservation 擁有 Booker／Guest 快照、付款嘗試、取消、退款與到期。
Reservation 透過 Availability 接受交易物件的能力，在同一交易內改狀態與占用或釋放房晚。第一版不另拆
pricing、guest、payment 或 policy 模組。

建立 Reservation 時須重新檢查 Quote fingerprint、供應、逐晚價格與政策。內容完全一致才建立；內容變更時
回傳新 Quote 要求再次確認，售完則拒絕。取消立即把 Reservation 轉為 `cancelled` 並在同一交易釋放房晚；
已付款的退款另以 `refund_pending` 重試，失敗不恢復 Reservation。已過期或取消後抵達的成功付款是 Late Payment，
只記錄並進入全額退款，不復活 Reservation。

Reservation 第一版只使用 `pending_payment`、`confirmed`、`expired` 與 `cancelled` 四個契約狀態；住宿前、
住宿中與已過住宿日期由 Property 當地日期推導，不在沒有入住作業流程時記錄 `checked_in`、`completed` 或
`no_show`。Email 只帶短期、單次的簽章 Access Grant；兌換後才把隨機 management token 放進安全 cookie，
並轉址到不含憑證的 URL。資料庫只保存 management token hash，原始 token 不進通知、URL、DB 或 log。
Reservation number 與 Email 不構成授權。Account link 只來自 authenticated actor，或有效 management session
後的顯式 claim；不接受 client account id，也不依 Email 自動連結。

第一版只保存主要 Guest 姓名、成人與兒童數、Booker 姓名／Email／電話及選填住宿備註，不收同行者完整名單
或證件。Booking config 必須提供 retention policy，住宿結束超過期限後由排程匿名化不再需要的個資；期限由
營運與適用法規決定，不寫進 Base。

第一版付款只接受 Provider 可驗證結果的即時或延後方法；到店付款、人工匯款與訂金尾款不在範圍內。
顧客只可在政策期限內整筆取消並全額退款；營運者可整筆取消並指定不超過實收的退款金額與稽核原因。
取消仍立即釋放房晚，退款結果另行追蹤。

一筆 Reservation 可以在前一個 Payment Attempt 明確失敗或到期後重試，但同時只能有一筆未終結 Attempt；付款
啟動重送須回傳同一筆 Attempt。Callback、取消、到期與期限延長先鎖 Reservation，再鎖 Attempt，需要房晚時最後
依日期鎖 Room Night。第一筆成功付款確認 Reservation；第二筆成功是 Excess Payment，與 Late Payment 一樣記錄
後全額退款。可退款 Booking Release 只能選取通過 refund contract 的 Provider；現有 ECPay 必須補上 refund 實作與
staging UAT 才能解除 release gate。

`booking-availability` 以 `(room_type_id, local_date)` 的 Room Night 資料列保存 sellable units、reserved units
與 nightly price。建立、取消、到期與調整 sellable units 都依日期固定排序鎖列；所有日期都有足夠數量時才在同一
交易占用並建立 Reservation，任一晚不足則整筆失敗。

Booking 擁有通知事件、觸發時機、模板與文案；Base Notification 只提供排程、寄送、重試、delivery log
與 provider adapter，不認識 Reservation。

共用 Release 契約與 bootstrap 應由 `packages/platform/release` 擁有，Base、Commerce 與 Booking 的產品組裝
則分別放在 `packages/releases/`。既有 `packages/commerce/` 不為目錄整齊而搬移；Booking 的三個產品模組放在
`packages/booking/`。ReleaseDefinition 是邏輯上的單一建置來源，但以 target-specific projection／package subpath
分開 server、worker、Admin browser 與 CLI；共用 manifest 只帶 key 與 metadata，不直接同時持有 Nest、React
與 backend factory。各 build target 只匯入自己的 projection，API、Admin、CLI 與建置腳本不得用 release id
分支產品行為。

設定檔名由 ReleaseDefinition 宣告：既有 Commerce 保留 `commerce.yaml`，Booking 使用 `booking.yaml`，共用 CLI
不猜測產品名稱。Payment Provider ABI 移除 `orderId`／`orderNumber`，改收唯一 `reference`、給人看的
`displayReference`、金額、幣別與方法；Commerce 與 Booking 各自把產品編號映射進來，付款 callback 仍只回傳
唯一 reference。這次 ABI 升版須同一批更新 Commerce、Mock Payment 與 ECPay。

Booking 第一版每個 Property 使用單一幣別與整數最小貨幣單位，房價為含稅價且不另收服務費；電子發票不在
第一個驗證切片。Reservation 建立後不修改日期、房型或房數，改期須取消並以當下價格與供應重訂；Booker
聯絡資料、主要 Guest 與住宿備註可留下 audit 後更新。

Booking config 預設最遠可訂 365 天、單筆最長 30 晚、`pending_payment` 保留 15 分鐘；延後付款可採 Provider
回傳的較長期限。單筆房數另有請求上限且不得超過每晚 available units；總入住人數不得超過房數乘以
`max_occupancy_per_unit`，且每房至少一位成人。日期、人數與範圍在查詢資料庫前驗證。

前台沿用模組 page declaration 與 Theme renderer，啟動時檢查必要 renderer。互動較重的 Booking 後台需要
建置期 Admin contribution 契約，由 Product Module 宣告 route、navigation、permission 與 UI entry，Release
只編入選取模組的頁面。Booking REST adapter 只負責把產品 HTTP 契約轉成 Command／Query；第一版不公開任意
Command 的通用 REST 入口。

ERP 是檢驗這個方向的應用例子。本文件不要求現在建立完整 ERP，也不宣稱目前基底已能
支援所有業務需求；後續可先用一個小型非商務應用走通上述流程。

## 既有文件的分工

- 本文件擁有跨應用復用的目標與分工原則。
- [架構文件](architecture.md)說明目前的程式結構與執行流程。
- [Spec 0009](specs/0009-complete-modular-base.md)管理既有基底能力矩陣與交付驗收；
  跨應用方向不自動增加完整 ERP 的交付範圍。
- [Base 執行計畫](base-implementation-plan.md)保留工作包與證據；後續 quality、release 或產品工作
  會另行取得範圍，不以概念文件偷渡成新的實作要求。
