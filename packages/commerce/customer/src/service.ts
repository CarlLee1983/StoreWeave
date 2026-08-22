import { PlatformError, type Actor, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { UserRepository } from '@storeweave/identity';
import { CustomerRepository } from './repository';

const customers = new CustomerRepository();
const accounts = new UserRepository();

const ACCOUNT_PREFIX = 'user:';

export interface CustomerIdentity {
  customerId: string;
  accountId: string;
  displayName: string;
  email: string;
}

/**
 * 由 Actor 反查下單者。order 模組在同一交易內呼叫它——訂單的歸屬不能靠呼叫端自己填。
 *
 * customer 模組在這裡橋接帳號：email 屬於帳號（platform_users），
 * 顯示名稱與生日屬於顧客。兩邊都需要的地方由這支負責，讓 order 不必認識 identity。
 */
export const customerService = {
  accountIdOf(actor: Actor): string | null {
    if (actor.type !== 'customer') return null;
    return actor.id.startsWith(ACCOUNT_PREFIX) ? actor.id.slice(ACCOUNT_PREFIX.length) : actor.id;
  },

  /** 只要 customerId 的路徑用它——訂單範圍限縮不需要 email，別為它多打一次帳號表。 */
  async customerIdOf(db: DrizzleDb | Tx, actor: Actor): Promise<string | null> {
    const accountId = this.accountIdOf(actor);
    if (!accountId) return null;
    const customer = await customers.findByAccountId(db, accountId);
    if (!customer) throw PlatformError.notFound('Customer', accountId);
    if (customer.status !== 'active') throw PlatformError.forbidden('This customer account is disabled');
    return customer.id;
  },

  async requireByActor(db: DrizzleDb | Tx, actor: Actor): Promise<CustomerIdentity> {
    const accountId = this.accountIdOf(actor);
    if (!accountId) {
      throw PlatformError.forbidden('Only a signed-in customer can do this; sign in or create an account first');
    }

    const customer = await customers.findByAccountId(db, accountId);
    if (!customer) throw PlatformError.notFound('Customer', accountId);
    if (customer.status !== 'active') throw PlatformError.forbidden('This customer account is disabled');

    const account = await accounts.findById(db, accountId);
    if (!account) throw PlatformError.notFound('Account', accountId);

    return {
      customerId: customer.id,
      accountId,
      displayName: customer.displayName,
      email: account.email,
    };
  },
};
