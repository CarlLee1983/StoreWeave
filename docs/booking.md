# Booking 使用與開發指南

Booking 是獨立的住宿預訂 Product Release，使用自己的資料庫、`booking.yaml`、
`booking-default` Theme，以及 Property、Availability、Reservation 三個產品模組。
它與 Commerce 共用 Platform、Base 能力及 Payment Provider 契約，但不共用訂單或商務資料表。
業務規則與不支援的情境以 [Spec 0011](specs/0011-booking-product-release.md) 為準。

## 目前可用的功能

| 使用者 | 入口 | 功能 |
| --- | --- | --- |
| 訪客 | `/property`、`/rooms`、`/rooms/:roomTypeId` | 查看住宿地點與有效房型 |
| 訪客 | `/booking/search`、`/booking/quote` | 依日期、人數及房數查供應與含稅總價；價格或供應改變時重新確認 Quote |
| Booker | Booking 公開 API、管理連結 | 建立暫時占用房晚的 Reservation、付款，以及以單次 Access Grant 取得管理 session |
| Booker | Reservation 管理 API | 查看自己的訂房、期限內整筆取消、重發管理連結、登入後明確連結 Account |
| 營運者 | `/admin/property`、`/admin/room-types` | 管理住宿地點、房型與房型圖片參照 |
| 營運者 | `/admin/availability`、`/admin/reservations` | 設定逐晚供應與價格；查詢訂房、付款／退款／通知紀錄，執行取消與退款重試 |

公開 REST 路由位於 `/api/v1/booking`；管理連結、營運者操作分別位於
`/api/v1/booking/management` 與 `/api/v1/booking/operator`。完整輸入、輸出與權限
以運行中 Release 的 HTTP catalog 和 `/api/v1/meta/commands`、`/api/v1/meta/queries` 為準。
Reservation 可以匿名建立。`pending_payment` 與 `confirmed` 占用房晚；取消或到期即釋放，
退款由背景工作獨立重試。Worker 必須與 API 一起運行。

## 在本機組裝 Booking

需要 Node.js 22 以上、`package.json` 指定的 pnpm、獨立的 PostgreSQL 資料庫。
目前 Booking 可由通用建置器產生 API、Worker、Admin、CLI 與 Theme artifact：

```bash
pnpm install
STOREWEAVE_RELEASE=booking pnpm build
```

建立 `booking.yaml`，指向專用資料庫，並以環境變數或私有秘密檔提供實際秘密。
下例使用環境 Secret Provider；資料庫 URL 與簽章金鑰不寫入設定檔：

```yaml
version: 1
store:
  id: booking-demo
  name: Booking demo
  locale: zh-TW
  timezone: Asia/Taipei
  currency: TWD
database:
  url: ${BOOKING_DATABASE_URL}
  autoMigrate: false
http:
  publicUrl: http://localhost:3000
security:
  signingKeys:
    - id: k1
      secretRef: BOOKING_SIGNING_KEY_K1
booking:
  maxRoomsPerRequest: 5
  reservationPiiRetentionDays: 365
  operatorAlertEmail: operator@example.test
extensions:
  - id: mock-payment
mail:
  transport: disabled
secrets:
  provider: env
```

將 `operatorAlertEmail`、`publicUrl`、資料保存期限及資料庫／簽章金鑰換成該環境的值。
在同一個 shell 設定 `STOREWEAVE_CONFIG`（指向 `booking.yaml`）、`BOOKING_DATABASE_URL` 與
`BOOKING_SIGNING_KEY_K1`，再用建置產物執行：

```bash
node dist/app/cli.js migrate
node dist/app/api.js
# 另一個終端機，使用相同設定與秘密：
node dist/app/worker.js
```

Booking seed 只執行 migration，沒有 `--demo` 示範資料。啟動後由有權限的營運者在
Admin 建立 Property、Room Type、基本房價及逐晚可售數，公開搜尋才會有可訂房型。
第一個管理員由 CLI 的 `user:create --email <email> --name <name> --role admin` 建立；
目前共用 CLI 從 `COMMERCE_USER_PASSWORD` 環境變數讀取密碼，切勿把密碼放在命令參數。
管理員登入 `/admin` 後設定 MFA，再依序完成住宿地點、房型、房價與供應量設定。
上例的 Mail 預設關閉，因此 Access Grant 通知不會寄達 Booker，不能用來驗證匿名管理連結。
要走完整的通知與管理旅程，將 `mail` 改為 `transport: smtp`，填入有效的 `from`、
`smtp.host`、`smtp.port` 與 TLS 設定；需認證時再設定成對的 `usernameRef`、`passwordRef`
並在 Secret Provider 提供其值。先確認 SMTP 能把信寄到測試收件匣，再測單次連結兌換。
通用 CLI 的健康檢查、token、備份與還原流程見[維運文件](operations.md)；
Booking 與 Commerce 的設定、資料庫及備份不可混用。

## 交付界線

Booking release 目前只選用 `mock-payment`；設定 schema 會拒絕其他付款 Extension。
ECPay refund staging UAT 與外部真實金流驗收尚屬獨立 release gate。
根目錄 `compose.yaml`、`Dockerfile` 和原生安裝媒體目前提供 Base／Commerce 部署範本，
不提供 Booking 的一鍵部署路徑。正式部署前仍需完成該產品的環境設定、部署驗證與營運驗收。
