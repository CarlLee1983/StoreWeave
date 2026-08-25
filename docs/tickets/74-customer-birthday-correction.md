# 74 — 客服修正會員生日

**What to build:** `commerce.customer.setCustomerBirthday` 的 summary 寫著「客服代為修正
會員生日」，但它沒有 HTTP 端點也沒有 UI。前台 profile 只在第一次填得進去，之後欄位是
`disabled`；生日禮券（工單 35）綁在這個欄位上，顧客填錯就永遠領不到，而客服沒有更正的路。

**Blocked by:** —

**Status:** completed

- [x] customer controller 補上生日更正端點，權限走既有的 `customers:manage`
- [x] 後台會員頁可修正生日，強制填寫原因，稽核留下操作者、原值與新值
- [x] 修正不補發已經錯過的生日禮券——那是另一個決定；UI 要說明這件事
- [x] 補 HTTP 與 jsdom 測試，涵蓋原因必填與無權限的 403

## 不做的事

- 顧客自助修改生日。生日決定發券資格，自助修改等於讓人一年領十二次；維持只有客服能改。
