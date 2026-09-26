# 116 — Booking 房型圖片缺少公開預覽端點

**原始問題（修正前）：** Booking Default Theme 在有 `mediaAssetId` 的 Room Type 頁面輸出 `/booking/media/:id/preview`，但當時 Booking HTTP adapter 沒有這條路由。SW-120 明確將公開端點及 active Room Type reference 授權交給 SW-135；SW-135 的現有實作沒有交付。SW-138 組裝 Theme 後，房型圖片請求會得到 404。

**狀態：** 已實作，selected Booking Release 整合測試 3/3 與 Sol/high 獨立增量審查通過；本批 `make verify` 已通過（SW-146 checkpoint 4）。SW-135 擁有此公開媒體授權邊界。

## 驗收

- [x] 實作 `GET /booking/media/:id/preview`，僅允許目前 active Room Type 所引用的媒體，並維持 Base Media 的私有儲存邊界。
- [x] 不存在、未引用、或僅由 inactive Room Type 引用的媒體不洩漏內容；加入 HTTP 回歸測試。
- [x] Booking release 組裝後，含合法圖片的 Room Type 頁面可載入該圖片；`make verify` 通過。

## 證據

- 2026-09-26：`tests/integration/booking-release-journey.test.ts` 驗證真實媒體處理、房型 SSR 圖片 URL、WebP 回應，以及不存在／未引用／disabled／移除引用時不開啟 storage。回應使用 `no-store`；Property 的 `getPublicMedia` 只查詢一筆 active 引用，不載入全部房型 DTO。完整本批證據見 [SW-146 follow-up](../../specs/stories/SW-146-booking-verification/follow-up-verification.md)。

- `specs/stories/SW-120-booking-property-theme/story.md` 約束段將這個公開端點與授權指定給 SW-135。
- 修正前，`packages/themes/booking-default/src/index.ts` 輸出 `/booking/media/:id/preview`，但 Booking adapter 未提供路由；現在由 `apps/api/src/controllers/booking-media.controller.ts` 實作，並由 `apps/api/src/releases/booking.ts` 掛載。
- 既有通用 Media preview 需要 `media:read` 私有權限，不能直接對匿名訪客開放。

## Migration 與回復

- 新增 Booking Property `0002_active_room_type_media_lookup`，為 active 房型的 `media_asset_id` 建立部分索引；既有 `0001` 與資料不改寫。整合測試確認 PostgreSQL 實際索引及 active predicate。
- 既有部署執行一般交易式 `CREATE INDEX` 時會短暫阻擋 Room Type 寫入，須納入正常 migration 維護時段。回復應用版本可保留此索引；若後續要移除，另以受控 migration 執行，不回改歷史 migration。
