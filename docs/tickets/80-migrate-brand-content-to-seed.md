# 80 — 織日內容搬進 seed，`brand-content.ts` 下線

**What to build:** 內容有了 Core 的家之後，`packages/themes/default/src/brand-content.ts`
的品牌故事與三篇生活誌要轉成 `scripts/seed.ts` 的資料並刪除原檔。依 coding-style 的
「不留相容層」，不保留讀靜態常數的 fallback：內容只有一個來源。順帶把新寫的兩則最新消息與
四則常見問題一起放進去，讓 `/news` 與 `/faq` 在 demo 環境有東西可看。文件同步：
`CONTEXT.md`、`docs/architecture.md`、`docs/adr/README.md`、`docs/specs/README.md`。

**Blocked by:** 76, 77

**Status:** completed

- [x] 品牌故事的三個章節以帶 `heading` 的區塊表達，前台呈現與這一輪之前一致
- [x] 生活誌三篇的配圖沿用原本的固定編輯搭配（`journal-room` / `journal-pause` / `journal-occasion`）
- [x] `docs/architecture.md` 的模組清單與資料表前綴補正——它一直只寫 catalog / inventory / order，
      實際已有十四個 commerce 模組
- [x] `CONTEXT.md` 新增「聯絡訊息」詞彙，並把品牌內容那則補上所有權、區塊與配圖 key 的說明
- [x] 起 docker compose 對全新資料庫實跑：migration 含 `content/0001_init`，
      seed 建立並發布 10 / 10 篇（story 1、journal 3、news 2、faq 4），
      品牌故事 4 個區塊其中 3 個帶標題——正好對回原本的三個章節
- [x] 重跑 seed 不產生重複（冪等鍵讓 command 重播回原結果，總數仍是 10）。
      原本的訊息寫「本次發布 10 篇」，在第二次執行是假的，改成「已確保 N 篇為發布狀態」
- [x] 整批失敗時不再靜默：slug 已存在照舊略過，其他原因印出來——
      否則十篇都沒進去也沒有人看得出來

## 為什麼實跑一次

`pnpm seed` 在測試裡沒有覆蓋，型別檢查也證明不了它對資料庫做了什麼。實跑抓到兩件
單元測試看不見的事：seed 訊息在重跑時說謊，以及首頁 hero 的 H1 與品牌區塊的 H2
印出同一句話（見工單 77 的「不做的事」）。後者在瀏覽器上一眼就看得出來，
而原本的斷言只檢查「包含這個字串」，出現兩次也算通過。
