# 60 — 超商門市選店與目的地回填

**What to build:** 將既有 `pickup_store` 目的地模型接成顧客可用的門市搜尋／選店流程，優先由綠界物流
adapter 提供門市資料或選店頁。跨站回填必須使用單次、短效、限定 Cart 的選店回填權杖。

**Blocked by:** 59

**Status:** ready-for-agent

- [ ] checkout 只在相容的 shipping method 顯示超商取貨；宅配與門市欄位不能混填
- [ ] 門市選店／回填驗證 token、Cart 所有權、時效、店號、provider/type 相容性與一次性使用
- [ ] 回填後顯示門市名稱、地址與取貨人資訊，建立訂單時凍結 destination snapshot
- [ ] session cookie 缺席的跨站 POST 仍可安全完成回填；不得以任意 Cart id 取代權杖
- [ ] 補 token 重放、過期、跨顧客、錯誤店號與正常流程的 HTTP/integration 測試

## 不做的事

- 同時選多間門市、地圖 SDK 與多物流商抽象化 UI。
