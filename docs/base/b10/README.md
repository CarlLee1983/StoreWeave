# B10 — Media 與圖片處理

- 狀態：**implemented；本機技術驗收已完成，外部 storage／release staging 仍由 B17 gate 追蹤**
- 決策：[ADR 0048](../../adr/0048-media-is-a-base-capability.md)
- 驗收：[acceptance.md](acceptance.md)

`platform-media` 是 Base 與 Commerce 共用的媒體模組。它擁有 asset identity、alt text、處理狀態、
preview 衍生物與跨模組 reference；物件 bytes、namespace、hash 與實體刪除仍只由 B09 Storage 擁有。
原圖一律存為 private object，公開頁面必須由擁有內容的模組另外授權，不把泛用 media preview
變成匿名入口。

## 行為與邊界

- `MediaService.upload()` 先串流寫入 private storage，再於同一 DB transaction 建立 `pending` asset
  與版本化 `platform.media.process` job；DB 失敗會補償刪除剛上傳的 object。
- Worker 才會 lazy-load Sharp。JPEG／PNG／WebP 經像素、尺寸與處理時間限制後產生固定 WebP preview；
  `generation` 是 retry fencing token，同一代重放不會多建衍生物。
- 處理失敗保持可觀察的 `failed` 狀態；retry 增加 generation 並以 `replaceExisting` 重排同一 logical job。
- Reference 由 `(media_asset_id, owner_type, owner_id)` 唯一識別；仍被引用的 asset 拒絕刪除。
  刪除中斷保留 `deleting` intent，`platform.media.cleanup-orphans` 可重跑完成清理。
- `/api/v1/media` 的 upload/list/get/alt/retry/delete/preview 都要求 media permission；preview 回應為
  `private, no-store`，不揭露 storage namespace 或 object id。Admin `MediaLibraryPage` 使用同一組 HTTP 入口。

## 主要檔案

| 邊界 | 入口 |
| --- | --- |
| lifecycle、migration、job payload | `packages/platform/media/src/index.ts` |
| runtime module／Worker 接線 | `packages/platform/kernel/src/runtime.ts` |
| authorized HTTP | `apps/api/src/controllers/media.controller.ts` |
| Admin caller | `apps/admin/src/pages/MediaLibraryPage.tsx` |
| 真圖片與失敗流程 | `tests/integration/media.test.ts` |
| Base HTTP 授權／非公開內容 | `tests/integration/base-release.test.ts`、`tests/integration/content-domain.test.ts` |
| 跨 Theme 與完整復原 | `tests/integration/b17-acceptance.test.ts`、`tests/integration/full-restore.test.ts` |

## 操作與回復

部署前需確認 Worker 能載入 release 內的 Sharp native binary，且 storage data root／bucket 不在 release
目錄。升級、回復或換 storage 前先停止 API／Worker 等外部 writers 並 drain active media jobs，再依 B15
執行 `backup --include-media`／full-bundle restore；不能用 git revert 或 DROP table 取代 DB＋object 的一致
回復。回復不自動刪除 asset、reference 或 storage object。

本機測試的 LocalObjectStore 與 release smoke 不能代替授權 staging 的真 S3、private-media URL 與權限證據；
該外部 gate 保留在 [B17 acceptance](../b17/acceptance.md)。B14 的 legacy Theme image-key 回填另由
[ADR 0049](../../adr/0049-content-is-a-base-module-and-media-migrates-by-evidence.md) 與
[B14 README](../b14/README.md) 管理。
