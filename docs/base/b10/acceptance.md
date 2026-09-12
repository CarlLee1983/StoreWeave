# B10 acceptance — Media 與圖片處理

這份表補回 B10 owner evidence。`implemented` 代表目前 repository 有可重跑的實作與測試；真 S3、
private-media staging 與已發布 release 的回復仍是 B17 外部 gate，不能由本機測試代填。

| 驗收項目 | 證據 | 狀態 |
| --- | --- | --- |
| Base／Commerce 都載入獨立的 `platform-media` module 與 migration | `packages/platform/kernel/src/runtime.ts`；`tests/integration/base-release.test.ts`、`release-transition.test.ts` | implemented |
| 私有原圖以串流上傳；DB 失敗補償 object，任意使用者不能指定 namespace／key | `MediaService.upload`；B09 contract；media/base HTTP integration | implemented |
| 真 JPEG／PNG／WebP decoder、像素／尺寸／timeout 限制、固定 WebP preview | `MediaService.process`；`tests/integration/media.test.ts` 使用真 PNG＋Sharp | implemented |
| Worker crash/replay 不建立第二份衍生物；retry 由 generation fencing 保護 | `platform.media.process` v1 contract；`media.test.ts` 的 processing reclaim、ready replay、failed retry | implemented |
| 無效 bytes 可觀察為 failed 且可安全 retry | `media.test.ts` invalid-source case | implemented |
| 引用中的 asset 不可刪除；刪除 intent 與 orphan cleanup 可重跑 | `platform_media_references`、`MediaService.remove/cleanup`；`media.test.ts` conflict case | implemented |
| HTTP upload/list/status/alt/retry/delete/preview 有 permission 與 private cache policy | `apps/api/src/controllers/media.controller.ts`；`tests/integration/base-release.test.ts` | implemented |
| Admin 有實際 Media Library caller | `apps/admin/src/pages/MediaLibraryPage.tsx`、routes/API；Admin suite | implemented |
| Theme 切換保存 asset/reference/original bytes | `tests/integration/b17-acceptance.test.ts` | implemented |
| DB、pending media job、original/preview bytes 一致備份與回復 | `tests/integration/full-restore.test.ts`、B15 full-bundle smoke | implemented（synthetic/current binaries） |
| Docker／native 可載入 Sharp | B15 Base／Commerce smoke；Dockerfile 與 native release artifact tests | implemented（既有 release evidence） |
| 真 S3、private-media staging 與已發布前版 binary 的升級／回復 | [B17 acceptance](../b17/acceptance.md) | pending（external release gate） |

回復前置是停止 writers、drain media jobs 並取得 DB＋object 的一致 recovery point。Rollback 不 DROP
`platform_media_assets`／`platform_media_references`，也不刪 storage objects；若舊 binary 不認得新 schema，
依 B15 full-bundle restore 或 forward-fix，不直接切回舊程式。
