import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PlatformError, type Actor, type DrizzleDb, type Tx } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { cartItems, carts, type CartItemRow, type CartRow } from './schema';

/** 訪客 token 只存雜湊，與 session token 的處理一致。 */
export function hashGuestToken(token: string): string {
  return createHash('sha256').update(`cart:${token}`).digest('base64url');
}

export interface CartOwner {
  customerId: string | null;
  guestTokenHash: string | null;
}

/**
 * 誰的購物車：登入者一律以自己的身分為準，訪客才看 token。
 * 兩者都沒有就是還沒有可以掛東西的地方——這時候拒絕比默默開一台孤兒車好。
 */
export async function resolveOwner(
  db: DrizzleDb | Tx,
  actor: Actor,
  guestToken: string | undefined,
): Promise<CartOwner> {
  if (actor.type === 'customer') {
    const me = await customerService.requireByActor(db, actor);
    return { customerId: me.customerId, guestTokenHash: null };
  }
  if (!guestToken) {
    throw PlatformError.validation('A guest cart needs a guest token; sign in or start a session first');
  }
  return { customerId: null, guestTokenHash: hashGuestToken(guestToken) };
}

function ownerCondition(owner: CartOwner) {
  return owner.customerId
    ? and(eq(carts.customerId, owner.customerId), eq(carts.status, 'open'), isNull(carts.guestTokenHash))!
    : and(eq(carts.guestTokenHash, owner.guestTokenHash!), eq(carts.status, 'open'), isNull(carts.customerId))!;
}

export class CartRepository {
  async find(db: DrizzleDb | Tx, owner: CartOwner): Promise<CartRow | null> {
    const [row] = await db.select().from(carts).where(ownerCondition(owner)).limit(1);
    return row ?? null;
  }

  /** 找不到就開一台。並行的第一次加入由唯一索引擋下，重試一次即可拿到對方建的那台。 */
  async findOrCreate(tx: Tx, owner: CartOwner, now: Date): Promise<CartRow> {
    const existing = await this.find(tx, owner);
    if (existing) return existing;

    const [created] = await tx
      .insert(carts)
      .values({
        id: randomUUID(),
        customerId: owner.customerId,
        guestTokenHash: owner.guestTokenHash,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const raced = await this.find(tx, owner);
    if (!raced) throw PlatformError.conflict('Could not open a cart; please retry');
    return raced;
  }

  async items(db: DrizzleDb | Tx, cartId: string): Promise<CartItemRow[]> {
    return db.select().from(cartItems).where(eq(cartItems.cartId, cartId)).orderBy(cartItems.createdAt, cartItems.id);
  }

  async addQuantity(tx: Tx, cartId: string, productId: string, delta: number, now: Date): Promise<void> {
    await tx
      .insert(cartItems)
      .values({ id: randomUUID(), cartId, productId, quantity: delta, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.productId],
        set: { quantity: sql`${cartItems.quantity} + ${delta}`, updatedAt: now },
      });
  }

  async setQuantity(tx: Tx, cartId: string, productId: string, quantity: number, now: Date): Promise<void> {
    await tx
      .insert(cartItems)
      .values({ id: randomUUID(), cartId, productId, quantity, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.productId],
        set: { quantity, updatedAt: now },
      });
  }

  async removeItem(tx: Tx, cartId: string, productId: string): Promise<void> {
    await tx.delete(cartItems).where(and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId))!);
  }

  async clear(tx: Tx, cartId: string): Promise<void> {
    await tx.delete(cartItems).where(eq(cartItems.cartId, cartId));
  }

  async touch(tx: Tx, cartId: string, now: Date): Promise<void> {
    await tx.update(carts).set({ updatedAt: now }).where(eq(carts.id, cartId));
  }
}
