import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 一張券。指向一條促銷規則，有自己的生命週期。
 *
 * 共用碼是**沒有擁有者**的券，多人可用；實發券有擁有者，只有那個人用得了。
 * 行銷碼是共用碼再加一個合作夥伴——折價行為完全相同，唯一的增量是歸因。
 */
export const coupons = pgTable('coupon_coupons', {
  id: uuid('id').primaryKey(),
  /** 顧客輸入的字樣。比對前一律正規化成大寫，避免「我打對了啊」。 */
  code: text('code').notNull(),
  promotionId: uuid('promotion_id').notNull(),
  status: text('status').notNull().default('issued'),
  /** 有擁有者就是實發券；null 是共用碼。 */
  customerId: uuid('customer_id'),
  /** 歸因對象。一張訂單最多只能有一個帶歸因的券。 */
  partnerCode: text('partner_code'),
  /** 總使用次數上限。null 是不限量。 */
  maxRedemptions: integer('max_redemptions'),
  /** 已核銷次數。以條件更新扣減，是限量的唯一權威。 */
  redeemedCount: integer('redeemed_count').notNull().default(0),
  /** 每個會員最多用幾次。null 是不限。 */
  perCustomerLimit: integer('per_customer_limit'),
  /** 這張券是怎麼來的：手動批次、註冊、生日。發放紀錄靠它與 batchId 追得回來。 */
  source: text('source').notNull().default('manual'),
  batchId: uuid('batch_id'),
  /**
   * 發放的去重鍵。事件重投與排程重跑都靠它擋下第二張，
   * 而不是靠呼叫端先查一次「這個人領過了嗎」。
   */
  issueKey: text('issue_key'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 每一次核銷的明細。這張表同時是行銷分析的事實來源——
 * 報表查它，不掃訂單全表。
 */
export const couponRedemptions = pgTable('coupon_redemptions', {
  id: uuid('id').primaryKey(),
  couponId: uuid('coupon_id').notNull(),
  promotionId: uuid('promotion_id').notNull(),
  orderId: uuid('order_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  code: text('code').notNull(),
  partnerCode: text('partner_code'),
  /** 這張券實際折抵了多少，正數。 */
  discountCents: integer('discount_cents').notNull(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CouponRow = typeof coupons.$inferSelect;
export type CouponRedemptionRow = typeof couponRedemptions.$inferSelect;
