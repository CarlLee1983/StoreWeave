# 0027. 外部回呼的端點屬於平台，Extension 沒有自己的 URL

- 狀態：accepted
- 日期：2026-08-24

## 背景

接上真實的台灣金流與物流之後，系統第一次需要**外部主動打進來**。這批至少有三條：
金流的付款確認（綠界的 `ReturnURL`）、非即時付款的取號通知（`PaymentInfoURL`）、
以及超商選店完成的回傳（`ServerReplyURL`）。三條都是跨站 POST，都由服務商發動。

在此之前這套系統沒有任何 webhook——工單 24 盤點舊版訂單事件時的結論就是
「平台沒有 webhook、沒有對外轉發」，那份訂閱者清單因此是空的。

問題在於這些回呼的內容**只有 provider 懂**。綠界是明文參數加 SHA256 的 CheckMacValue，
藍新是把整包參數 AES-256-CBC 加密成 `TradeInfo` 再加 SHA256 驗章——後者要先解密
才知道裡面是什麼。而 `ExtensionRegistration`（`packages/platform/extension-sdk/src/registration.ts`）
能貢獻的八類東西裡沒有 HTTP route，extension 也拿不到 `tx` 或 `db`：那個型別就是
資料所有權邊界的執行點。

## 決策

端點屬於平台，驗簽與解析屬於 provider。

`apps/api` 開一條泛用端點 `POST /callbacks/:kind/:providerId`，讀原始請求
（body、header、query 原封不動）交給 `ProviderRegistry` 取出的 provider，
由它的 `parseCallback(raw)` **一步完成驗證與解析**，回傳一個領域事件；
端點再把那個事件送進 Command Bus。

`parseCallback` 不拆成 `verify` 再 `parse` 兩步，因為藍新那一側「驗證」與「解析」
是同一個解密動作，拆開的介面它實作不出來。

回應內容也是 provider 的責任：`ackBody(result)` 決定回什麼字串。綠界要求
逐字回 `1|OK`（`1|ok`、空白都不算），沒正確回應會每 5–15 分鐘重送、同日最多四次；
藍新沒有這個要求。這個差異不外洩到 app。

`ExtensionRegistration` 維持八類，**不新增 `routes`**。

## 考慮過的選項

- **擴充 `ExtensionRegistration` 讓 extension 自帶 route。** 否決：架構文件的立場是
  所有介面共用同一組 handler、都走 Bus，REST、Storefront SSR、Admin、MCP、CLI、Worker
  六個入口無一例外。Extension 自帶 URL 等於開一條繞過 Bus 的路，而且那條路上沒有
  rate limit、沒有稽核、沒有 actor。更實際的問題是 extension 拿不到 `tx`，
  它接到回呼之後還是得回頭呼叫 Command——那 route 本身就沒有存在的理由。
- **為綠界硬寫專屬 controller。** 否決：直接放棄抽換性。第二家金流商進來時
  會長出第二個 controller，兩者的差異散在兩個檔案裡而不是收在 port 上。
- **回呼先落地成一張表，由 worker 非同步處理。** 否決：綠界的重送語意要求
  端點在回應之前就知道自己收下了，而「收下了」與「處理完了」對它是同一件事。
  多一層佇列只是把重送的判準搬到一個它看不到的地方。

## 後果

- 端點是平台的，因此可以套既有的 rate limit 與稽核，也可以在 provider 之前就
  擋掉不存在的 `providerId`。
- 換金流商不動端點，只換 `AVAILABLE_EXTENSIONS` 裡的那一行與設定。
- **選店回傳沒有身分**。session cookie 是 `SameSite=Strict`
  （`apps/api/src/http/session-cookies.ts`，配 `__Host-` 前綴，見 ADR 0023），
  跨站 POST 一律不帶——Lax 也一樣擋跨站 POST，所以降級換不到東西。
  身分因此由**選店回填權杖**承擔：短期、單次、只授權寫回門市這一件事，
  透過物流商的 `ExtraData` 欄位往返。權杖不是 cart id 本身——`ExtraData` 會出現在
  瀏覽器網址列與服務商後台，把 cart id 放進去等於交出那台車。
- 這條端點是系統對外的第一個非認證寫入面。它的授權完全來自簽章，
  因此簽章的正確性是安全邊界而不只是整合細節（見 ADR 0031 對測試的要求）。

## Falsified if

`packages/platform/extension-sdk/src/registration.ts` 的 `ExtensionRegistration`
長出 `routes` 或任何 HTTP 相關的欄位，或 `apps/api` 出現以特定服務商命名的
回呼 controller 而不是走 `POST /callbacks/:kind/:providerId`。

前者代表「所有介面都走 Bus」這條已經被放棄，後者代表抽換性已經不是目標——
兩者任一成立，這篇的前提就不在了。
