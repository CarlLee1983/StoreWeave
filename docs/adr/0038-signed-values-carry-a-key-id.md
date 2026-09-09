# 0038. 簽發值帶 key id，金鑰依用途推導

- 狀態：accepted；B12 片1 實作、單元回歸與 typecheck 通過。
- 日期：2026-09-09

所有由平台簽發、會離開行程的值——B09 的短效下載連結、B08 的密碼重設與驗證信連結——採同一個格式：`sw1.<keyId>.<到期秒>.<payload>.<mac>`。驗證端提供用途，MAC 以該用途的子金鑰計算。加密值另用 `swe1.` 前綴，語意相同。

金鑰不是一把，而是設定裡的一組。`security.signingKeys` 宣告 `id` 與 `secretRef`，`activeSigningKeyId` 指定新值用哪一把；驗證接受所有仍在設定裡的 id。輪替因此是「加一把、改 active、等舊值到期、再移除」，不需要停機，也不需要一次作廢所有已發出的連結。只有一把時 active 可省略，兩把以上必須明說——輪替期間簽錯金鑰是無聲的錯誤。

子金鑰由 root secret 以 HKDF-SHA256 推導，info 為 `storeweave/v1/<keyId>/<purpose>`。取代「一把金鑰簽全部」的理由是跨用途偽造：若下載連結與密碼重設共用金鑰，能取得任一個下載簽章的人就能構造出重設連結的材料。推導後兩者的金鑰材料不相關，而營運端仍只需管理每個 key id 一個秘密。用途同時進 MAC 輸入，是重複的一層。

驗證回報 `malformed`、`unknown_key`、`bad_signature`、`expired` 四種結果而不丟例外，因為四者的處置不同：金鑰已退場要看輪替紀錄，被竄改要看攻擊面，單純過期是正常流程。順序固定為格式、金鑰、簽章、到期——先確認簽章成立才檢查到期，否則過期訊息會告訴攻擊者他偽造的 token 通過了簽章。

不可逆的部分：`keyId` 一旦發行就不能重新指派給另一個秘密，否則舊連結會被新秘密驗成有效。從設定移除一把金鑰，等同立即作廢它簽過而尚未到期的所有值；這是刻意的作廢手段，不是清理設定的順手動作。

密碼雜湊不走這條路。`packages/platform/identity/src/password.ts` 的 scrypt 參數寫在雜湊字串裡、隨登入逐步升級，與這裡的 key id 是兩套獨立的演進機制，合併只會讓兩者都動不了。ECPay 的 CheckMacValue 與 AES-128-CBC 也維持原樣：那是廠商契約，不是我們可以選的格式。

## Falsified if

`packages/platform/crypto/src/signed-value.ts` 產出的字串不再第二段就是 key id，或 `packages/platform/crypto/src/keyring.ts` 不再以 purpose 推導子金鑰（改為所有用途共用同一把金鑰材料），或 `packages/platform/config/src/schema.ts` 的 `security.signingKeys` 退回單一金鑰欄位而無法同時保留舊 id，或 `packages/platform/kernel/src/keyring.ts` 在宣告金鑰卻讀不到秘密時不再於啟動失敗；任一成立表示輪替不再能無停機執行，須重開本決策。
