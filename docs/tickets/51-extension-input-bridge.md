# 51 — Extension 的輸入納入 strict，橋接改為明挑欄位

**What to build:** `ext.demo-erp.*` 三支輸入補上 `.strict()`，與 ADR 0024 的其餘 API 保持同一個答案。
前提是先讓 `apps/api/src/controllers/extensions.controller.ts` 的橋接**明挑欄位**：今天它把整包
query string 往下送，收緊後任何帶 `_t=` 這類 cache-buster 的呼叫會立刻 400。挑欄位的依據是
Bus 上那支 descriptor 自己宣告的鍵，不是控制器裡另抄一份清單。

**Blocked by:** 50

**Status:** done

- [x] 橋接依 descriptor 宣告的鍵過濾 query string；未宣告的鍵在進 Bus 前就被丟掉
- [x] `ext.demo-erp.resendOrder`、`listDeliveries`、`inspectDeliveryPayload` 三支輸入 `.strict()`
- [x] Extension Contract Test 多兩項：「輸入拒絕未知欄位」與「輸入是橋接挑得出鍵的平 object」，對所有 extension 生效而不只 demo-erp
- [x] 挑掉的鍵記一行 `logger.warn`（只記鍵名）——否則這裡就成了新的「安靜忽略」
- [x] `docs/extension-development.md` 的範例與常見錯誤表跟上：照文件抄的人第一次跑 Contract Test 就要是綠的
- [x] Command 的 JSON body 維持整包往下送——那裡沒有 cache-buster 慣例，多的鍵就該是 400
- [x] ADR 0024 的「Extension 暫時不在範圍內」改寫成已納入，並記下兩側為何不對稱

## 為什麼 query string 與 body 不一樣

query string 是公共空間：瀏覽器、CDN、前端的 `?_t=` 都會往上加鍵，而呼叫端沒有辦法阻止。
在那裡回 400 等於把「別人加的東西」算到呼叫端頭上。JSON body 沒有這個問題——body 裡多出來的鍵
一定是呼叫端自己送的，那正是 ADR 0024 要讓它看得見的情況。

挑欄位放在橋接而不是放進每一支 handler，是因為這是 HTTP 這一層的事：Bus 上的契約說得出自己收哪些鍵，
橋接照著念就好。控制器裡再抄一份白名單，下一支 extension 註冊時就會忘記更新。
