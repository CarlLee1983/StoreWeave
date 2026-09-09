/**
 * Extension 只能透過 SDK 接入平台能力，不得直接 import 平台套件。安全比較是
 * callback 驗章的必需品，所以由這裡轉出，而不是讓每個 Extension 自己寫一份
 * `a === b`——那正是本層要消除的差異。
 */
export { constantTimeEquals } from '@storeweave/crypto';
