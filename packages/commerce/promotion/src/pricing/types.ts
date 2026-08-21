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
  /** 數字小的先套用。 */
  priority: number;
  stackable: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
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
  [key: string]: unknown;
}

export interface PricingInput {
  lines: PricingLineInput[];
  context: PricingContext;
  /** 當下時間。引擎不讀時鐘。 */
  now: Date;
  /** 本規格不計算運費與稅，欄位存在是為了讓門檻的定義有地方被證明。 */
  shippingCents?: number;
  taxCents?: number;
}

export interface Adjustment {
  source: 'promotion';
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

export interface PricingResult {
  subtotalCents: number;
  /** 所有折扣的絕對值合計，保證不超過 subtotalCents。 */
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  adjustments: Adjustment[];
  appliedPromotions: AppliedPromotion[];
  /** 與輸入的商品行同順序。 */
  lines: PricedLine[];
}
