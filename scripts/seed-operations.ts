import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { bootstrap } from '@storeweave/bundle';
import type { Actor, Runtime } from '@storeweave/kernel';

/**
 * 營運面的示範資料：訂單、退款、退貨、物流、發票、通知。
 *
 * 與 `seed.ts` 分開跑：那支種的是目錄與帳號（改一次就好），這支種的是每天
 * 開發時想看到的流程資料，而且刻意做成可以重複執行——每次都建新的一批，
 * 讓「失敗的退款」「等待收件的退貨」這些狀態隨時都有東西可看。
 */

const SYSTEM: Actor = { id: 'seed:operations', type: 'system', displayName: 'Operations Seed', permissions: ['*'] };
const customerActor = (accountId: string): Actor => ({ id: accountId, type: 'customer', permissions: ['*'] });

/** 每次執行都是新的一批資料，冪等鍵帶上這個前綴才不會撞到上一次的。 */
const RUN = process.env.SEED_RUN_ID ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14);
let step = 0;
const key = (name: string) => `seed-ops-${RUN}-${name}-${++step}`;

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

async function accountIdOf(runtime: Runtime, email: string): Promise<string> {
  const rows = await runtime.database.db.execute<{ id: string }>(
    sql`SELECT id FROM platform_users WHERE lower(email) = lower(${email})`,
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error(`找不到帳號 ${email}，請先執行 pnpm seed`);
  return id;
}

async function productIds(runtime: Runtime, skus: string[]): Promise<Record<string, string>> {
  const rows = await runtime.database.db.execute<{ id: string; sku: string }>(
    sql`SELECT id, sku FROM catalog_products WHERE sku IN (${sql.join(skus.map((s) => sql`${s}`), sql`, `)})`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.sku, r.id]));
}

interface PlacedOrder {
  id: string;
  number: string;
  totalCents: number;
  lines: { id: string; productId: string; sku: string; name: string; quantity: number }[];
}

/**
 * 走購物車結帳。placeOrder 是「直接下單」的捷徑，不會留下配送快照，
 * 而沒有配送快照就建不了物流單、也就沒有退貨案件可示範。
 */
async function checkout(
  runtime: Runtime,
  actor: Actor,
  lines: { productId: string; quantity: number }[],
  shippingMethodId: string,
): Promise<PlacedOrder> {
  for (const item of lines) {
    await runtime.commands.execute(
      'commerce.cart.addToCart',
      { productId: item.productId, quantity: item.quantity },
      { actor, idempotencyKey: key('add-to-cart') },
    );
  }
  const cart = await runtime.queries.execute<{ id: string }>('commerce.cart.getCart', {}, { actor });
  return runtime.commands.execute<PlacedOrder>(
    'commerce.order.checkoutCart',
    {
      cartId: cart.id,
      shippingMethodId,
      destination: {
        kind: 'taiwan_home',
        countryCode: 'TW',
        recipient: actor.displayName ?? '示範收件人',
        phone: '0912345678',
        postcode: '106',
        city: '臺北市',
        district: '大安區',
        line1: '復興南路一段 100 號 5 樓',
        line2: null,
      },
    },
    { actor, idempotencyKey: key('checkout-cart') },
  );
}

/** 下單並付款成功。付款走 recordPaymentResult，不必真的打到金流。 */
async function payFor(runtime: Runtime, actor: Actor, order: PlacedOrder): Promise<PlacedOrder> {
  await runtime.commands.execute(
    'commerce.order.payOrder',
    { orderId: order.id },
    { actor, idempotencyKey: key('pay-order') },
  );

  // 顧客視角的 Order DTO 不帶付款嘗試（那是後台與金流的東西），
  // 所以直接讀最後一筆 attempt 來回填結果。
  const attempts = await runtime.database.db.execute<{ attempt_ref: string; provider: string; status: string }>(
    sql`SELECT attempt_ref, provider, status FROM order_payments WHERE order_id = ${order.id} ORDER BY created_at DESC LIMIT 1`,
  );
  const attempt = attempts.rows[0];
  if (attempt && attempt.status !== 'succeeded') {
    await runtime.commands.execute(
      'commerce.order.recordPaymentResult',
      { attemptRef: attempt.attempt_ref, provider: attempt.provider, status: 'confirmed', providerRef: `mock:${order.number}` },
      { actor: SYSTEM, idempotencyKey: key('payment-result') },
    );
  }
  return order;
}

async function placeAndPay(
  runtime: Runtime,
  actor: Actor,
  lines: { productId: string; quantity: number }[],
  options: { pay: boolean },
): Promise<PlacedOrder> {
  const order = await runtime.commands.execute<PlacedOrder>(
    'commerce.order.placeOrder',
    { lines },
    { actor, idempotencyKey: key('place-order') },
  );
  return options.pay ? payFor(runtime, actor, order) : order;
}

async function seedOperations(runtime: Runtime) {
  console.log('🌱 注入營運示範資料（訂單 / 退款 / 退貨 / 物流 / 發票 / 通知）...');

  const aliceAccount = await accountIdOf(runtime, 'alice@example.com');
  const vipAccount = await accountIdOf(runtime, 'gold_vip@woven-day.test');
  const alice = customerActor(aliceAccount);
  const vip = customerActor(vipAccount);

  const skus = ['WD-POT-01', 'WD-POT-02', 'WD-POT-03', 'WD-TEX-01', 'WD-TEX-03', 'WD-WD-01'];
  const products = await productIds(runtime, skus);
  const missing = skus.filter((s) => !products[s]);
  if (missing.length) throw new Error(`找不到商品 ${missing.join(', ')}，請先執行 pnpm seed`);

  const line = (sku: string, quantity = 1) => ({ productId: products[sku]!, quantity });

  // 兩條路徑互斥，訂單要分開養：直接退款只接受「還沒進入出貨流程」的訂單，
  // 而退貨案件反過來要求已經出貨。同一張訂單不可能兩者都示範。
  const shipmentOf = async (order: PlacedOrder, stage: 'created' | 'shipped') => {
    const shipment = await runtime.commands.execute<{ id: string }>(
      'commerce.shipping.createShipment',
      { orderId: order.id, providerRef: `carrier:${order.number}`, trackingNumber: `TW${order.number.replace(/\D/g, '')}` },
      { actor: SYSTEM, idempotencyKey: key('create-shipment') },
    );
    if (stage === 'shipped') {
      await runtime.commands.execute(
        'commerce.shipping.advanceShipmentStage',
        { shipmentId: shipment.id, status: 'shipped' },
        { actor: SYSTEM, idempotencyKey: key('advance-shipment') },
      );
    }
    return shipment;
  };

  // ── 訂單：待付款、已付款、已取消 ─────────────────────────────
  const pending = await placeAndPay(runtime, alice, [line('WD-POT-03', 2)], { pay: false });
  console.log(`  ✓ 待付款訂單 ${pending.number}（${money(pending.totalCents)}）`);

  const refundOk = await placeAndPay(runtime, alice, [line('WD-POT-01'), line('WD-TEX-03', 2)], { pay: true });
  const refundFail = await placeAndPay(runtime, vip, [line('WD-TEX-01', 3)], { pay: true });
  const homeDelivery = await runtime.queries.execute<{ items: { id: string; code: string }[] }>(
    'commerce.shipping.listShippingMethods',
    { limit: 50 },
    { actor: SYSTEM },
  );
  const method = homeDelivery.items.find((m) => m.code === 'black-cat-delivery') ?? homeDelivery.items[0];
  if (!method) throw new Error('找不到任何配送方式，請先執行 pnpm seed');

  const shippedA = await payFor(runtime, vip, await checkout(runtime, vip, [line('WD-WD-01'), line('WD-POT-02')], method.id));
  const shippedB = await payFor(runtime, vip, await checkout(runtime, vip, [line('WD-POT-03')], method.id));
  const packing = await payFor(runtime, alice, await checkout(runtime, alice, [line('WD-TEX-01')], method.id));
  console.log(`  ✓ 已付款訂單 ${[refundOk, refundFail, shippedA, shippedB, packing].map((o) => o.number).join(' / ')}`);

  const cancelled = await placeAndPay(runtime, alice, [line('WD-POT-02')], { pay: false });
  await runtime.commands.execute(
    'commerce.order.cancelOrder',
    { orderId: cancelled.id, reason: '顧客改買其他款式' },
    { actor: alice, idempotencyKey: key('cancel-order') },
  );
  console.log(`  ✓ 已取消訂單 ${cancelled.number}`);

  // ── 退款：一筆成功、一筆卡在失敗（退款佇列才有東西可重試）────────
  // provider 證據必須與建立時一致（providerRequestRef 是退款自己發的），
  // 所以回填結果時直接沿用回傳值，不要自己編一個。
  const okRefund = await runtime.commands.execute<{ id: string; paymentProvider: string; providerRequestRef: string }>(
    'commerce.refund.requestFullRefund',
    { orderId: refundOk.id, reason: '商品與描述不符' },
    { actor: SYSTEM, idempotencyKey: key('request-refund') },
  );
  await runtime.commands.execute(
    'commerce.refund.recordRefundResult',
    { id: okRefund.id, paymentProvider: okRefund.paymentProvider, providerRequestRef: okRefund.providerRequestRef, status: 'succeeded', providerRefundRef: `provider-refund:${okRefund.id}` },
    { actor: SYSTEM, idempotencyKey: key('refund-result') },
  );

  const badRefund = await runtime.commands.execute<{ id: string; paymentProvider: string; providerRequestRef: string }>(
    'commerce.refund.requestFullRefund',
    { orderId: refundFail.id, reason: '尺寸不合' },
    { actor: SYSTEM, idempotencyKey: key('request-refund') },
  );
  await runtime.commands.execute(
    'commerce.refund.recordRefundResult',
    { id: badRefund.id, paymentProvider: badRefund.paymentProvider, providerRequestRef: badRefund.providerRequestRef, status: 'failed', failureMessage: '金流回覆：原授權已逾期，需改用人工匯款' },
    { actor: SYSTEM, idempotencyKey: key('refund-result') },
  );
  console.log('  ✓ 退款：1 筆成功、1 筆失敗（可在退款佇列重試）');

  // ── 物流：出貨中與剛建單各一，出貨工作台才有單可查 ───────────────
  await shipmentOf(shippedA, 'shipped');
  await shipmentOf(shippedB, 'shipped');
  await shipmentOf(packing, 'created');
  console.log(`  ✓ 物流單：${shippedA.number} / ${shippedB.number} 已出貨，${packing.number} 已建單`);

  // ── 退貨：停在不同狀態，讓每個操作入口都有案件可按 ───────────────
  const rmaLines = (order: PlacedOrder, sku: string) => {
    const target = order.lines.find((l) => l.sku === sku) ?? order.lines[0]!;
    return [{ orderLineId: target.id, quantity: 1 }];
  };

  await runtime.commands.execute(
    'commerce.rma.createRma',
    { orderId: shippedA.id, reason: '收到時杯口有缺角', lines: rmaLines(shippedA, 'WD-POT-02') },
    { actor: vip, idempotencyKey: key('create-rma') },
  );
  console.log('  ✓ 退貨案件：已申請（可核准 / 要求補件 / 拒絕）');

  const approved = await runtime.commands.execute<{ id: string }>(
    'commerce.rma.createRma',
    { orderId: shippedA.id, reason: '尺寸與想像中差太多', lines: rmaLines(shippedA, 'WD-WD-01') },
    { actor: vip, idempotencyKey: key('create-rma') },
  );
  await runtime.commands.execute(
    'commerce.rma.approveRma',
    { id: approved.id, note: '已確認照片，同意退貨' },
    { actor: SYSTEM, idempotencyKey: key('approve-rma') },
  );
  console.log('  ✓ 退貨案件：已核准（可登記收件）');

  const received = await runtime.commands.execute<{ id: string }>(
    'commerce.rma.createRma',
    { orderId: shippedB.id, reason: '重複下單', lines: rmaLines(shippedB, 'WD-POT-03') },
    { actor: vip, idempotencyKey: key('create-rma') },
  );
  await runtime.commands.execute(
    'commerce.rma.approveRma',
    { id: received.id },
    { actor: SYSTEM, idempotencyKey: key('approve-rma') },
  );
  const receivedDetail = await runtime.queries.execute<{ lines: { id: string }[] }>(
    'commerce.rma.getRma',
    { id: received.id },
    { actor: SYSTEM },
  );
  await runtime.commands.execute(
    'commerce.rma.receiveRma',
    { id: received.id, lines: receivedDetail.lines.map((l) => ({ rmaLineId: l.id, disposition: 'restock' as const })) },
    { actor: SYSTEM, idempotencyKey: key('receive-rma') },
  );
  console.log('  ✓ 退貨案件：已收件（可申請退款）');

  console.log('\n🎉 營運示範資料完成。可重複執行，每次都會再建一批新的。');
}

async function main() {
  const configPath = process.env.COMMERCE_CONFIG ?? (
    existsSync(resolve('deployments/example-store/commerce.yaml'))
      ? resolve('deployments/example-store/commerce.yaml')
      : undefined
  );
  const { runtime } = await bootstrap({ configPath, loggerName: 'storeweave-seed-ops', logDestination: 'stderr' });
  try {
    await seedOperations(runtime);
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('❌ 營運示範資料注入失敗:', err);
  process.exit(1);
});
