# SW-189 以 GitHub Pages 發佈架構與功能文件

## Goal

StoreWeave 的架構、決策與開發說明目前只散在 repo 的 `docs/` Markdown 裡，外部讀者沒有一個可以瀏覽的入口。這張 Story 用 VitePress 把整個 `docs/` 建成網站，在 `main` 有推送時由 GitHub Actions 自動發佈到 GitHub Pages。首頁導向架構總覽、ADR、模組與 Extension 開發、部署文件，讓讀者不用 clone repo 就能了解系統。

## Out of Scope

- 改寫、翻譯或重新整理既有文件內容；只做讓網站能建置所需的最小修改，例如修正會讓建置失敗的連結。
- 自訂品牌、Logo、自訂網域，或客製站台主題。
- API reference 自動產生（TypeDoc、OpenAPI 等）。
- PR 預覽部署。
- 把文件建置納入 `make verify`。

## Acceptance Criteria

1. `package.json` 的 devDependencies 有 `vitepress`，且有 `docs:build` script；`pnpm docs:build` 以 exit 0 結束，且在建置輸出目錄產生 `index.html`。
2. `docs/` 底下每一份 `.md` 在建置輸出目錄都有對應的 `.html`，沒有排除任何子目錄。
3. 建置設定把失效的站內連結視為錯誤：在任一頁加入一個指向不存在頁面的連結時，`pnpm docs:build` 以非零結束。
4. `docs/` 中指向 `docs/` 之外 repo 檔案的相對連結（例如 `../../specs/...`），在建出的 HTML 裡改指向 `https://github.com/CarlLee1983/StoreWeave/blob/main/...` 的對應路徑。
5. 首頁有連到 `docs/architecture.md`、`docs/adr/README.md`、`docs/module-development.md`、`docs/extension-development.md`、`docs/deployment-docker.md`、`docs/deployment-native.md` 對應頁面的連結。
6. `.github/workflows/` 新增一支 workflow，觸發條件只有 push 到 `main` 和 `workflow_dispatch`，用 `actions/upload-pages-artifact` 與 `actions/deploy-pages` 部署，permissions 只宣告 `contents: read`、`pages: write`、`id-token: write`。
7. repo 的 GitHub Pages 已啟用，來源設為 GitHub Actions：`gh api repos/CarlLee1983/StoreWeave/pages` 回傳 `build_type: workflow` 和 `html_url`。
8. 合併到 `main` 後，用 `curl -sI` 對 `html_url` 的首頁和架構頁發請求，都回傳 HTTP 200。
9. `README.md` 有一行連到該 `html_url`。
10. `make verify` 通過。
