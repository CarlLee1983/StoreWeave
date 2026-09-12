# B17 — 整體驗收與交付

- 狀態：in_progress（技術驗收切片已落地；外部 release gates 仍待環境）
- 日期：2026-09-12
- 規格：[Spec 0009 §8](../../specs/0009-complete-modular-base.md#8-最終驗收)

B17 把既有 B00–B16 的證據接成可重跑的驗收入口。這一輪沒有新增第四個 runtime release：形象站與 Blog
是同一份 Base module graph 的兩個資料設定檔，分別使用自己的資料庫與 storage root。這保留 migration
與 release identity 的語意，也直接驗證「下一個網站只需換組裝／設定」的目標。

## 已落地的技術切片

- Base、File Requests 與 Commerce 都提供兩個相容 Theme：`base`／`editorial` 或
  `default`／`editorial`。Theme 只保存自己的 `options`；網站標語、導覽、內容、媒體和 URL 仍由資料表擁有。
- `tests/integration/b17-acceptance.test.ts` 以真實 PostgreSQL 驗證同版的 shopping、image-site 與 Blog
  profiles；兩個獨立 Base profile 確認內容可發布且沒有 Commerce module／table，Commerce profile 確認
  shopping catalog 可啟動，並在 Base → Editorial 的重啟之間比較 article、media asset、media reference、
  原始媒體 SHA-256、site settings 與 navigation。
- `tests/architecture/b17-acceptance.test.ts` 驗證同一 `PLATFORM_VERSION`、每個 release 的雙 Theme、
  commerce-free module manifest、缺少必需 renderer 時在 runtime 前拒絕，以及 B00 保留識別仍可在目前
  Commerce runtime／Extension registry 或明列的 legacy baseline 找到。
- `docs/base/b17/b00-catalog.json` 分開保存 B00 基準與目前 composed registry：B00 的逗號縮寫展開為
  76 Commands／57 Queries／19 Events／14 Jobs；目前完整 registry 為 89／66／19／18，包含 B10 的
  `setArticleMedia` 與後續 platform descriptors/jobs。B07 移到 base notification capability 的
  lifecycle job 則列在 `legacyOnly`。B17 先核對兩份清單的數量與唯一性，再逐一對照目前 registry，
  避免用後來新增的識別填補基準缺口；`recordLifecycleDelivery` 仍保留讓舊 worker／operations seed 可使用。
- `packages/themes/base/test/base-theme.test.ts` 固定兩個 Base Theme 的 renderer 集合與預設視覺選項。

## 版本與重跑指令

本輪 source 的固定版本如下：

| 層級 | 版本／schema |
| --- | --- |
| package／release | `0.1.0` |
| Base platform compatibility | `1.0.0` (`PLATFORM_VERSION`) |
| release manifest | schema `1` |
| runtime config | schema `1` |
| Base／Commerce module pins | Base：`content@0.0.0`、其餘 `0.1.0`；Commerce：`content@0.0.0`、`rma@0.0.0`、其餘 `0.1.0` |

用同一 release version 建立兩份網站 artifact：

```sh
STOREWEAVE_RELEASE=base STOREWEAVE_RELEASE_VERSION=0.1.0 \
  STOREWEAVE_BUILD_DIR=/tmp/storeweave-b17-base node scripts/build.mjs --skip-admin
STOREWEAVE_RELEASE=commerce STOREWEAVE_RELEASE_VERSION=0.1.0 \
  STOREWEAVE_BUILD_DIR=/tmp/storeweave-b17-commerce node scripts/build.mjs --skip-admin
```

每份輸出的 `build-info.json`、`release-manifest.json` 與 `*.meta.json` 是 checksum 與 dependency graph
的證據來源；測試不會改寫或自動更新任何 baseline。

同版 `0.1.0` 的本機 build 結果（2026-09-12）：

| release | `release-manifest.json` checksum |
| --- | --- |
| base | `sha256:2233da31bd5989acf0e3ed750b00dde7d64612992a671c7e9ac20a4f98c8707e` |
| commerce | `sha256:fcea5196a9192f10cee9fd5cc92d8f07f3c8c55cf78cd833c878dbf5012f9433` |

## 驗證紀錄

本輪已執行：

```sh
pnpm typecheck
pnpm exec vitest run --project unit tests/architecture/b17-acceptance.test.ts packages/themes/base/test/base-theme.test.ts
pnpm exec vitest run --project integration tests/integration/b17-acceptance.test.ts
pnpm exec vitest run --project integration tests/integration/full-restore.test.ts
make verify
```

`make verify` 已通過（unit 99 files／1,182 tests、admin 32 files／350 tests、integration 106 files／890
tests）。PR #45 的 [CI run](https://github.com/CarlLee1983/StoreWeave/actions/runs/34675547015) 也在 source
`6d062f9` 通過 typecheck、unit、admin、完整 integration、Commerce Docker 與 native smoke；但該 run 沒有
上傳 artifact，也沒有把 release-manifest checksum 寫入 smoke 證據，所以不能代替 checksum-bound 的雙 release
smoke、真實 SMTP／S3、private-media staging、商家 UAT 與正式開通 gate。

加入完整回復演練後，final-source `make verify` 再次通過（unit 99 files／1,182 tests、admin 32 files／350
tests、integration 106 files／891 tests）；獨立 Sol/high review 的持久資料、cleanup、determinism 與複雜度
findings 已清零。

B17 後續補上的 `tests/integration/full-restore.test.ts` 單一演練，以目前編譯的 Commerce release 為 N，加入
probe migration 的 patch 版為 N+1：來源同時保存 site data、待執行 media job、原圖與 preview；N+1
migration 後由新版 Worker 解碼並完成來源 job，最後用 N 的 full bundle 回復，確認 job id／occurrence／
payload version／run time、媒體 metadata 與從 bundle 重建的兩份 SHA 全部回到同一 recovery point；
quarantine database 仍保有 N+1 release history、completed job 與專屬資料表。這證明 stopped-writer 流程的
deterministic mechanics，不是已發布舊 binary 的相容證據，也不偵測違反停寫流程而持續執行的舊 Worker。
實際 API／Worker entrypoint mismatch 由 `tests/integration/release-artifacts.test.ts` 的兩份 Base build artifact
直接驗證。

`file-requests` 是 B16 的 build／integration example。它目前不是 native release identity：
`build-release.sh`、installer 與 paired snapshot schema 仍只接受 `commerce`／`base`。B17 不把它誤列為
native delivery，也不在本輪擴大 install／rollback identity。

## 回復與剩餘風險

Theme 切換沒有 migration；回復時先把設定的 Theme id 切回舊 Theme，再切回保留的 release artifact。
DB、storage object 與 queued job 的完整 cold recovery 沿用 B15 的 paired snapshot／full bundle 流程；
舊 binary 無法讀取新 schema 時不能直接 rollback，必須依 B15 的 restore 或 forward-fix 演練。

整體 F01–F16、公開 payload 的完整 golden catalog、checksum-bound 雙 release smoke、真實 transport、
商家 UAT、已發布 binary 的升級證據與下一個真實案子的重用成本，仍在 [acceptance matrix](acceptance.md)
明列為 pending、外部 gate 或後續 release evidence。
