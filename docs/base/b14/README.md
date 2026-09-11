# B14 — 內容／Blog 與品牌媒體遷移

- 狀態：verified（`make verify`）
- 日期：2026-09-11

## 操作

先執行 migration 並確保 Worker 正在處理 B10 job，再以實際 release 的預設 Theme asset 目錄執行：

```sh
storeweave content:backfill-legacy-media --assets-dir /path/to/theme/assets
```

第一次通常回報 `waiting`；待處理完成後以同一個命令重跑。只有 report 的 `waiting` 與 `failed` 都為零，
而且已逐項比較 mapping、article `media_asset_id`、B10 reference 與 manifest digest，才可提出 legacy
`image_key` contract 變更。此 B14 不授權那個 contract 或刪除 `/storefront-assets/`。

網站設定的 `contactNotificationEmail` 可選擇接收 B07 email 通知；空值維持只建立 contact 收件匣記錄。

## 驗收重點

- `content` 的歷史 identity、article/contact id 與 slug 不變；Base 不載入 Customer。
- 草稿不可出現在 storefront、RSS、sitemap、公開 media preview 或 navigation。
- 文章 list 支援分頁；文章／列表輸出 canonical 與 description。
- legacy bytes digest 不符時回填失敗且不建立 media asset；ready 後才補 reference。
