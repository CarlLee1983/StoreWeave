# 0048. 使用者媒體是 Base 能力，位元組仍由 Storage 管理

- 狀態：accepted（B10 實作中）
- 日期：2026-09-11

## 決策

`platform-media` 是 Base 模組，Base 與 Commerce release 都載入。它擁有媒體 asset 的識別、alt text、處理狀態、衍生 preview 與引用紀錄；B09 的 `platform-storage` 繼續唯一擁有物件位元組、namespace、hash 與實體刪除。

原圖一律以 private storage object 保存。worker 以版本化 `platform.media.process` job 處理 JPEG、PNG、WebP，限制像素、邊長和處理時間，再產生固定規格的 WebP preview。asset 的 `generation` 是 fencing token；舊 job 不得寫回重試後的 asset。刪除前查詢 `platform_media_references`；有引用的 asset 拒絕刪除。跨模組引用沒有外鍵，遵守 ADR 0021。

上傳的位元組與資料列無法同一交易提交，所以資料列建立失敗時補償刪除剛上傳的物件；處理產物在 worker 失敗時也補償刪除。rollback 不刪資料表或物件，並須先 drain active media jobs。

## 與 ADR 0034 的關係

ADR 0034 仍有效，且只管理既有 Theme 隨 release 發布的 editorial key。B10 不改 `content_articles.image_key`，也不移除 `/storefront-assets/`。B14 才會做 expand、舊圖片映射、比對、cutover 與 contract 階段的清理授權；在那之前不能宣稱 Theme 圖已遷移。

## Falsified if

`platform-media` 直接儲存檔案位元組、公開輸入能選 storage key／bucket、或 content 對 `platform_media_assets` 加跨模組外鍵，任一項成立都需重開本決策。
