# 57 — 結帳總額透明與顧客自助付款操作

**What to build:** 讓 checkout 在提交前依選取的 shipping method 顯示含運費總額，並在訂單頁提供
付款失敗／待付款的安全續付，以及尚未付款訂單的顧客取消入口。不能改變已凍結訂單的總額，
也不能把已付款退款偽裝成取消。

**Blocked by:** 56

**Status:** done

- [x] 選擇運送方式時以既有費率與免運門檻算出、顯示含運費總額；送出的值仍由伺服器重算
- [x] 待付款／失敗付款可建立新的 payment attempt 後續付；重送不共用舊 provider reference
- [x] 僅 `pending` 且未出貨訂單可由訂單擁有者取消，並重用既有庫存、優惠券、購物金回沖語意
- [x] 顧客看得到可採取動作與失敗原因，不能看見 provider secret 或 callback 原文
- [x] 補 storefront、command/integration 與授權回歸測試

## 不做的事

- 已付款退款、部分退款或退貨；它們屬於 63–65。
- 超商選店；它屬於 60。
