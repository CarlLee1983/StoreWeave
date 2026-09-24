# 116 — Booking 房型圖片缺少公開預覽端點

**問題：** Booking Default Theme 在有 `mediaAssetId` 的 Room Type 頁面輸出 `/booking/media/:id/preview`，但目前 Booking HTTP adapter 沒有這條路由。SW-120 明確將公開端點及 active Room Type reference 授權交給 SW-135；SW-135 的現有實作沒有交付。SW-138 組裝 Theme 後，房型圖片請求會得到 404。

**狀態：** 待實作；SW-138 不擴充原本 SW-135 負責的公開媒體授權邊界。

## 驗收

- [ ] 實作 `GET /booking/media/:id/preview`，僅允許目前 active Room Type 所引用的媒體，並維持 Base Media 的私有儲存邊界。
- [ ] 不存在、未引用、或僅由 inactive Room Type 引用的媒體不洩漏內容；加入 HTTP 回歸測試。
- [ ] Booking release 組裝後，含合法圖片的 Room Type 頁面可載入該圖片；`make verify` 通過。

## 證據

- `specs/stories/SW-120-booking-property-theme/story.md` 約束段將這個公開端點與授權指定給 SW-135。
- `packages/themes/booking-default/src/index.ts` 輸出 `/booking/media/:id/preview`，但 `apps/api/src/releases/booking.ts` 與其 controllers 無該路由。
- 既有通用 Media preview 需要 `media:read` 私有權限，不能直接對匿名訪客開放。
