/**
 * 定價引擎的資料契約。這一層刻意沒有任何資料庫、時鐘或隨機來源的相依：
 * 當下時間由呼叫端傳入，引擎本身是純函式。
 */

export interface PricingLineInput {
  /** 呼叫端自訂的行識別，分攤結果會用同一個值回傳。 */
  lineId: string;
  productId: string;
  unitPriceCents: number;
  quantity: number;
  /** 分類或標籤，供未來的指定範圍規則使用。 */
  categories?: string[];
}

export type PromotionRule =
  | { type: 'threshold_fixed_amount'; thresholdCents: number; discountCents: number }
  | {
      type: 'threshold_percentage';
      thresholdCents: number;
      /** 1_000 = 折 10%。用基點是為了讓「打 99 折」這種小數不必存浮點數。 */
      percentOffBasisPoints: number;
      maxDiscountCents?: number | null;
    }
  | { type: 'order_percentage'; percentOffBasisPoints: number; maxDiscountCents?: number | null };

export interface Promotion {
  id: string;
  name: string;
  /** 數字小的先套用；相同時以活動 id 決定，輸出因此與輸入陣列的排列無關。 */
  priority: number;
  /**
   * 只約束彼此：不可疊加的活動被套用後，後續**不可疊加**的活動不再套用。
   * 可疊加的活動在它前後都照常套用——這不是「不能與任何活動並存」。
   */
  stackable: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  /**
   * 只有這些等級適用。空陣列代表人人適用。
   * 等級不是另一套折扣系統——它只是「這條規則套不套用」的一個條件。
   */
  tierNames?: readonly string[];
  rule: PromotionRule;
}

/**
 * 開放結構：之後加入新的判斷依據（購物金餘額、購物車來源…）不算破壞性變更。
 * 刻意不含歷史消費額——那會讓每次結帳多一次統計查詢。
 */
export interface PricingContext {
  promotions: Promotion[];
  /** 會員等級。未登入時為 null。 */
  membershipTier?: string | null;
  /**
   * 開放結構的延伸欄位。用具名欄位而不是索引簽章，
   * 是為了讓 `promotinos` 這種拼錯被型別擋下而不是靜默變成「沒有活動」。
   */
  extra?: Record<string, unknown>;
}

export interface PricingInput {
  lines: PricingLineInput[];
  /**
   * 購物金折抵。**最後**套用，而且只作用在商品小計上——不折運費、不折稅。
   * 上限由呼叫端算好（可用餘額與小計的較小值），引擎只負責套用與分攤。
   */
  rewardRedeemCents?: number;
  context: PricingContext;
  /** 當下時間。引擎不讀時鐘。 */
  now: Date;
  /** 本規格不計算運費與稅，欄位存在是為了讓門檻的定義有地方被證明。 */
  shippingCents?: number;
  taxCents?: number;
}

export interface Adjustment {
  /** 折扣來自活動或購物金折抵。兩者的分攤與記帳方式相同，只有來源不同。 */
  source: 'promotion' | 'reward';
  sourceId: string;
  name: string;
  /** 折扣為負數。訂單總額 = 小計 + 所有 Adjustment。 */
  amountCents: number;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  /** 實際折抵的金額，正數。 */
  discountCents: number;
}

export interface PricedLine {
  lineId: string;
  lineTotalCents: number;
  /** 這一行實際被折抵的金額，正數。 */
  discountCents: number;
  /** 這一行的實收金額，保證不為負。開發票與部分退貨看的是它。 */
  netCents: number;
  /** 訂單層的每一筆調整攤到這一行的份額。 */
  adjustments: Adjustment[];
}

/**
 * 最接近、但還沒達成的門檻。前台用它說「還差多少」——
 * 那句話是門檻活動唯一的行銷價值，算不出來就等於活動只在結帳當下才存在。
 */
export interface ThresholdHint {
  promotionId: string;
  name: string;
  thresholdCents: number;
  /** 還差多少分才達得到，恆為正數。 */
  remainingCents: number;
}

export interface PricingResult {
  subtotalCents: number;
  /** 所有折扣的絕對值合計（含購物金折抵），保證不超過 subtotalCents。 */
  discountCents: number;
  /** 這次實際折抵掉的購物金。呼叫端據此寫帳本分錄。 */
  rewardRedeemedCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  adjustments: Adjustment[];
  appliedPromotions: AppliedPromotion[];
  /** 與輸入的商品行同順序。 */
  lines: PricedLine[];
  /** 差一點就達成的門檻活動；全部達成或沒有門檻活動時為 null。 */
  nextThreshold: ThresholdHint | null;
}
