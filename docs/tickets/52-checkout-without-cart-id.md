# 52 — 結帳沒帶 cartId 時不要問到一台新的空車

**What to build:** `POST /api/v1/cart/checkout` 少了 `cartId` 時的 fallback 會去問「現在的車」，
但那次查詢沒帶 `guestToken`，而且接受一台現產的空車：訪客會拿到一台跟自己無關的車，
會員在沒有車時會拿到一個指著陌生 uuid 的 404。正常流程畫面都會帶 `cartId`，這是防守用的路徑。

**Blocked by:** 28

**Status:** done

- [x] fallback 的 `getCart` 帶上既有的訪客 token（與 `GET /api/v1/cart` 同一支讀法，不簽發新的）
- [x] 車是空的就回 `VALIDATION_ERROR`，與結帳自己對空車的錯誤一致，而不是拿現產的 uuid 去結帳
- [x] 訪客沒帶 `cartId` 時擋下他的仍然是身分（403），而不是「找不到那台車」

## 為什麼不是把 fallback 拿掉

拿掉就變成沒帶 `cartId` 一律 400，那會把一個能正確完成的請求（會員只有一台車，
語意上沒有歧義）改成失敗。fallback 本身是對的，錯的是它問錯了車、又相信了一台不存在的車。
