---
title: "從零教學使用獨立 Notes Release 與真實交付驗證"
author: Carl
date: 2026-10-17
branch: fix/architecture-readability
touches:
  - Dockerfile
  - README.md
  - docs/.vitepress/config.mts
  - docs/architecture.md
  - docs/base/b17/commerce-public-contract.semantic.v2.json
  - docs/index.md
  - docs/module-development.md
  - pnpm-lock.yaml
  - scripts/releases.mjs
  - tests/architecture/fixtures/sw-102-release-baseline.v1.json
---

## Decided
使用者要求教材教會不套用購物功能的工程師自行開發。docs/learn/from-zero 以五課串起 Notes 自有 schema、migration、Command、Query、Page、Theme、Release 與測試。packages/examples/notes 選 platform-site/platform-auth/notes，不選 Content 或 Commerce；apps/api/src/releases/notes.ts 是明確的 HTTP adapter。Notes 僅草稿可改，發布後先收回；owner 條件與 revision/state 一起做 SQL 條件更新。operationId 防重送，revision 防過期覆寫，CSRF 防跨站，三者不可互代。

## Tried and ruled out
沿用 Content 做 Blog 可滿足使用既有功能的路線，但不能取代從零開發教材。Notes 沒有發出事件，因此既有 Content Extension 記憶體練習不能宣稱直接插入 Notes 即可生效。不要為教學修改 Core 或既有產品規則。

## Watch out
新 workspace package 需要 pnpm-lock importer，根 Dockerfile 的 workspace manifest COPY 也須納入，即使 Notes 自己有 Dockerfile。lockfile 和新來源會改 semantic ledger provenance；review 僅來源清單/lock hash，再同步 release-baseline fixture 對該 ledger 的 SHA，不改既有公開契約。Notes config 必須明確設定 /var/lib/notes 和 /var/lib/notes/backups，否則 Base defaults 指錯目錄。Signing key 使用 openssl rand -hex 32；standard base64 不是目前 keyring 接受的 base64url。Docker 已實測 rootless、Compose startup、doctor、Worker heartbeat、backup shared volume，使用獨立一次性 project 並清理。
trail check 對 config.mts、architecture.md、scripts/releases.mjs 的 admin/content/theme/REST 字詞命中是上下文誤判：前兩者為章節導覽，後者 Notes 的 forbiddenInputs 排除 Content/Commerce，並非恢復 Base Admin 或以共用 Theme 實作品牌需求。既有邊界維持。
