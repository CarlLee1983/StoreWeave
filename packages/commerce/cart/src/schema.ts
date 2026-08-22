import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 購物車。訪客以 token 的雜湊綁定、會員以顧客識別綁定，兩者擇一。
 * 購物車**不預留庫存**，也**不凍結價格**——兩者都發生在轉成訂單的那一刻。
 */
export const carts = pgTable('cart_carts', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id'),
  /** 訪客 token 只存雜湊：cookie 外洩不等於資料庫裡有一份可用的識別碼。 */
  guestTokenHash: text('guest_token_hash'),
  status: text('status').notNull().default('open'),
  /** 結成的那張訂單。重複送出的結帳靠它回到同一張單，而不是靠呼叫端記得帶對冪等鍵。 */
  orderId: uuid('order_id'),
  /** 本次要使用的券。存碼而不是券 id：券可能在結帳前被停用，屆時要能說出是哪一組碼失效。 */
  couponCode: text('coupon_code'),
  /** 顧客希望折抵多少購物金。實際折抵額在試算與結帳時各自重新夾限。 */
  rewardRedeemCents: integer('reward_redeem_cents').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cartItems = pgTable('cart_items', {
  id: uuid('id').primaryKey(),
  cartId: uuid('cart_id').notNull(),
  productId: uuid('product_id').notNull(),
  quantity: integer('quantity').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CartRow = typeof carts.$inferSelect;
export type CartItemRow = typeof cartItems.$inferSelect;
