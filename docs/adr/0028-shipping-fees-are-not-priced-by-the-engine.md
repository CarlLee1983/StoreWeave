# 0028. 運費與免運不經定價引擎，也不問物流商

- 狀態：accepted
- 日期：2026-08-24

## 背景

`packages/platform/extension-sdk/src/providers.ts` 的 `ShippingProvider` 從一開始就
帶著 `quote()`——那是在還沒有任何實作時憑直覺畫的形狀，看起來很合理：問物流商運費多少。

接上綠界之後才發現**數字不在那裡**。綠界物流沒有運費試算 API，運費是店家跟綠界簽的
合約費率；而店家對顧客收多少完全是另一回事——同一個超商取貨，可以收 60、收 0、
或滿 800 免運。物流商不知道，也不該知道。

另一邊，「滿額免運」看起來很像一條 Promotion。但 `PromotionRule`
（`packages/commerce/promotion/src/pricing/types.ts`）目前三種規則全是折商品，
而定價引擎有一條明文的不變式：折扣與購物金折抵一律不作用在運費與稅上。

## 決策

運費與免運門檻是**運送方式的欄位**，由店家在後台維護。定價引擎完全不知道它們的存在。

`ShippingProvider.quote()` 從 port 上**拿掉**。Provider 只負責它獨有的三件事：
選店導轉、建立物流單、狀態回拋。

`shippingCents` 由運送方式的費率決定，在 Cart 轉 Order 時與價格一起凍結，
填進 ADR 0015 早就留好但恆為零的那個欄位。

## 考慮過的選項

- **新增 `threshold_free_shipping` 規則型別，並把「折扣不作用於運費」從絕對規則
  改成「只有免運類規則可以」。** 否決，而且理由不是純潔性：`PromotionRule` 的每一種
  都會進分攤演算法，而 ADR 0015 定的是 Adjustment **必定分攤到 line**——退貨、開發票
  與對帳都需要知道每一件商品實際收了多少錢。免運分攤不到 line，它會是唯一的例外，
  而那個例外會沿著分攤路徑污染退貨與對帳的每一段。用兩個欄位換掉一條演算法上的例外，
  這筆交易很划算。
- **運費問 provider，adapter 內部拿自己的費率表回答。** 否決：那只是把店家的定價策略
  藏進 adapter，換物流商時整份費率跟著陪葬，而且後台改不到。
- **保留 `quote()` 但這批不用。** 否決，這是最危險的選項——一個留在 port 上的方法
  會誘導未來的人去問物流商要數字，而數字根本不在那裡。刪掉它，
  下一個人就得回來讀這篇。

## 後果

- **免運不能跟券綁在一起。** 「用這張券免運」在這個模型下做不到，因為 Coupon 指向
  Promotion，而 Promotion 碰不到運費。這是已知且接受的取捨；真要做，
  代價是上面「考慮過的選項」第一條的全部。
- 試算在未選運送方式時回 `shippingCents: null` 而不是 `0`。**未知與免費必須分得開**——
  滿額免運真的會讓運費是 0，兩者撞在一起就再也分不出來。這跟工單 56
  「數量上限只在 `available` 已知時輸出，未知時不猜測數值」是同一條原則。
- 運送方式因此需要後台 CRUD 與自己的權限（`shipping:read` / `shipping:write`），
  而不能是部署設定：費率是會變的商業參數，改一次運費不該要一次部署。

## Falsified if

`packages/platform/extension-sdk/src/providers.ts` 的 `ShippingProvider` 重新長出
`quote()` 或任何回傳金額的方法，或 `packages/commerce/promotion/src/pricing/types.ts`
的 `PromotionRule` 出現作用於運費的規則型別。

前者代表運費被認定為物流商的能力，後者代表分攤必定到 line 這條不變式已經鬆動——
兩者任一成立，這篇的理由要重新檢視。
