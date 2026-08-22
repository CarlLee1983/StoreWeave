import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 顧客的領域資料。帳號本身在 `platform_users`——這裡不存 email、不存密碼雜湊，
 * 平台的帳號模組也不知道生日是什麼。兩者以 `account_id` 相連。
 */
export const customers = pgTable('customer_customers', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  /** 生日與聯絡方式在工單 19 才填得到，欄位先就位。 */
  birthday: text('birthday'),
  phone: text('phone'),
  /** 預設收件地址。一位顧客一組，多組地址等真的需要時再開表。 */
  addressRecipient: text('address_recipient'),
  addressPhone: text('address_phone'),
  addressPostcode: text('address_postcode'),
  addressCity: text('address_city'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CustomerRow = typeof customers.$inferSelect;
