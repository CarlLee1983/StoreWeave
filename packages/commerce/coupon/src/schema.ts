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
