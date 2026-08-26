import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { bootstrap } from '@storeweave/bundle';
import { accountService } from '@storeweave/identity';
import type { Actor, Runtime } from '@storeweave/kernel';

const SEED_ACTOR: Actor = {
  id: 'seed:script',
  type: 'system',
  displayName: 'Seed Script',
  permissions: ['*'],
};

interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  description: string;
  stock: number;
}

const PRODUCTS: SeedProduct[] = [
  // 日常器皿 (Dining & Pottery)
  {
    sku: 'WD-POT-01',
    name: '白陶手作日常平盤',
    category: '器皿',
    priceCents: 88_000,
    description: '以台灣在地陶土手工拉胚製作，表面保留質樸手工旋紋與霧面微啞光感。適合盛裝早午餐、主食或常備菜。',
    stock: 35,
  },
  {
    sku: 'WD-POT-02',
    name: '炭黑粗陶茶杯雙入組',
    category: '器皿',
    priceCents: 128_000,
    description: '高溫還原燒製，質地堅實細緻，手感溫潤沉靜。盛裝熱茶或手沖黑咖啡，散發獨特的礦物光澤。',
    stock: 20,
  },
  {
    sku: 'WD-POT-03',
    name: '霧面米白釉色飯碗',
    category: '器皿',
    priceCents: 65_000,
    description: '符合手掌弧度的經典碗型，邊緣微侈口設計，就口舒適。溫潤米白色調讓每頓米飯看起來更顯香甜。',
    stock: 50,
  },
  {
    sku: 'WD-POT-04',
    name: '手作雙耳寬口湯缽',
    category: '器皿',
    priceCents: 115_000,
    description: '質樸寬口設計，雙耳握把便於端取。適合盛裝濃湯、燉菜、烏龍麵或一人份溫熱鍋物。',
    stock: 15,
  },
  {
    sku: 'WD-POT-05',
    name: '手吹薄壁玻璃水杯四入組',
    category: '器皿',
    priceCents: 148_000,
    description: '工匠手工吹製，杯壁薄透且具備優異透光度。在陽光下折射出如水波般的生動光影。',
    stock: 25,
  },
  {
    sku: 'WD-POT-06',
    name: '質樸柴燒小清酒器組',
    category: '器皿',
    priceCents: 220_000,
    description: '落灰柴燒技法，每件酒器皆呈現獨一無二的火痕與自然釉彩。附一壺二杯，適合靜謐獨酌。',
    stock: 8,
  },
  {
    sku: 'WD-POT-07',
    name: '長石釉日式長條燒物皿',
    category: '器皿',
    priceCents: 98_000,
    description: '長石釉高溫燒製，器型修長優雅。適合擺放烤魚、玉子燒、前菜小品或點心。',
    stock: 0, // 展示已售完狀態
  },
  {
    sku: 'WD-POT-08',
    name: '手捏陶作極簡花器',
    category: '器皿',
    priceCents: 168_000,
    description: '不對稱手捏造型，不施繁複釉彩，單插一枝枯枝或野花即能點亮室內一隅。',
    stock: 12,
  },

  // 手織布品 (Textile & Linen)
  {
    sku: 'WD-TEX-01',
    name: '重磅純麻雙色餐墊組 (2入)',
    category: '布品',
    priceCents: 78_000,
    description: '100% 頂級天然長纖亞麻編織，厚實耐用且吸水快乾。洗滌後自然微皺的紋理，呈現純粹生活美感。',
    stock: 40,
  },
  {
    sku: 'WD-TEX-02',
    name: '水洗棉麻十字交叉圍裙',
    category: '布品',
    priceCents: 158_000,
    description: '後背無綁帶交叉剪裁，穿脫俐落無負擔。雙側大容量口袋，料理、園藝或工藝手作皆適宜。',
    stock: 18,
  },
  {
    sku: 'WD-TEX-03',
    name: '蜂巢織紋純棉吸水擦手巾',
    category: '布品',
    priceCents: 42_000,
    description: '立體蜂巢格紋織法，蓬鬆透氣，觸感極為柔軟。附棉繩掛耳，便於廚房與衛浴懸掛晾乾。',
    stock: 60,
  },
  {
    sku: 'WD-TEX-04',
    name: '亞麻原色沙發抱枕套',
    category: '布品',
    priceCents: 95_000,
    description: '未經漂染的天然亞麻原色，透氣親膚，四季皆宜。隱形拉鍊設計，拆洗方便。',
    stock: 28,
  },
  {
    sku: 'WD-TEX-05',
    name: '手織天然染純棉方巾',
    category: '布品',
    priceCents: 38_000,
    description: '植物草木染製，色澤溫和深邃。可作隨身手帕、餐盒包巾或領巾點綴。',
    stock: 50,
  },
  {
    sku: 'WD-TEX-06',
    name: '大地色系羊毛純棉萬用毯',
    category: '布品',
    priceCents: 320_000,
    description: '精選美麗諾羊毛混紡純棉，輕盈且保暖性極佳。客廳披毯、床尾蓋毯或戶外露營皆不可或缺。',
    stock: 10,
  },
  {
    sku: 'WD-TEX-07',
    name: '輕透水洗亞麻長桌巾',
    category: '布品',
    priceCents: 188_000,
    description: '大尺寸 140x220cm 水洗麻料桌巾，自然垂墜感極佳，為餐桌鋪陳優雅安定的用餐氛圍。',
    stock: 15,
  },

  // 木作道具 (Wooden Utensils)
  {
    sku: 'WD-WD-01',
    name: '黑胡桃木手作雕刻托盤',
    category: '木作',
    priceCents: 248_000,
    description: '一體成型北美黑胡桃原木細細雕鑿，盤底帶有手工鑿刻紋路，天然蜂蠟塗層防潑水保護。',
    stock: 12,
  },
  {
    sku: 'WD-WD-02',
    name: '櫻桃木溫潤圓形點心盤',
    category: '木作',
    priceCents: 85_000,
    description: '櫻桃木細膩木紋，隨使用時間漸漸轉為溫潤紅褐色。盛放手工餅乾或烘焙麵包格外相襯。',
    stock: 30,
  },
  {
    sku: 'WD-WD-03',
    name: '栗木手作料理筷雙入組',
    category: '木作',
    priceCents: 48_000,
    description: '天然栗木輕巧耐水，八角箸身好握不滑手。筷尖精細打磨，夾取食物俐落準確。',
    stock: 45,
  },
  {
    sku: 'WD-WD-04',
    name: '柚木原木深口沙拉大盆',
    category: '木作',
    priceCents: 198_000,
    description: '富含天然油脂的頂級柚木製成，堅固抗潮。盛裝豐盛蔬果沙拉，散發大自然質樸氣息。',
    stock: 10,
  },
  {
    sku: 'WD-WD-05',
    name: '手工切削奶油抹刀組 (2入)',
    category: '木作',
    priceCents: 35_000,
    description: '工匠手工削製，弧形握柄好施力。塗抹果醬、發酵奶油或起司，順暢不傷麵包本體。',
    stock: 40,
  },
  {
    sku: 'WD-WD-06',
    name: '北美橡木厚切料理砧板',
    category: '木作',
    priceCents: 175_000,
    description: '厚達 3cm 原木拼板，軟硬適中不傷刀刃。雙面可用，亦可直接作為熟食拼盤上桌。',
    stock: 16,
  },

  // 居家與香氛 (Living & Scents)
  {
    sku: 'WD-LIV-01',
    name: '檜木與雪松天然大豆蠟燭',
    category: '香氛',
    priceCents: 118_000,
    description: '100% 天然非基改大豆蠟與台灣紅檜、雪松純精油，燃燒純淨無黑煙，帶來宛如置身山林般的沉靜香氣。',
    stock: 25,
  },
  {
    sku: 'WD-LIV-02',
    name: '實心黃銅手工線香座',
    category: '香氛',
    priceCents: 89_000,
    description: '重手實心黃銅車削，隨歲月氧化呈現沈穩古銅色澤。適用各式細短線香。',
    stock: 20,
  },
  {
    sku: 'WD-LIV-03',
    name: '手工草編提把收納籃',
    category: '生活',
    priceCents: 105_000,
    description: '天然水草純手工編織，柔軟而具韌性。可用於收納織品、雜誌書報或作為盆栽套籃。',
    stock: 14,
  },
];

async function seed(runtime: Runtime) {
  console.log('🌱 開始注入 StoreWeave 完整 Demo 資料...');

  // 1. 套用最新 Migrations
  const applied = await runtime.migrate();
  console.log(`✓ 檢查 Migration: ${applied.length ? `套用了 ${applied.length} 個` : '已是最新版本'}`);

  // 2. 物流配送方式 (Shipping Methods)
  const shippingMethods = [
    {
      code: 'black-cat-delivery',
      name: '黑貓宅急便（常溫宅配）',
      provider: 'manual',
      type: 'home_delivery',
      destinationKind: 'taiwan_home' as const,
      feeCents: 10_000, // $100
      freeShippingThresholdCents: 150_000, // 滿 $1,500 免運
      enabled: true,
    },
    {
      code: '711-pickup',
      name: '7-ELEVEN 超商取貨',
      provider: 'manual',
      type: 'pickup_store',
      destinationKind: 'pickup_store' as const,
      feeCents: 6_000, // $60
      freeShippingThresholdCents: 100_000, // 滿 $1,000 免運
      enabled: true,
    },
    {
      code: 'family-pickup',
      name: '全家便利商店取貨',
      provider: 'manual',
      type: 'pickup_store',
      destinationKind: 'pickup_store' as const,
      feeCents: 6_000, // $60
      freeShippingThresholdCents: 100_000, // 滿 $1,000 免運
      enabled: true,
    },
    {
      code: 'sf-express-express',
      name: '順豐速運特快配送',
      provider: 'manual',
      type: 'home_delivery',
      destinationKind: 'taiwan_home' as const,
      feeCents: 16_000, // $160
      freeShippingThresholdCents: 300_000, // 滿 $3,000 免運
      enabled: true,
    },
  ];

  for (const method of shippingMethods) {
    try {
      await runtime.commands.execute(
        'commerce.shipping.createShippingMethod',
        method,
        { actor: SEED_ACTOR, idempotencyKey: `seed-shipping-${method.code}` },
      );
      console.log(`  ✓ 配送方式: ${method.name}`);
    } catch {
      // 若已存在則略過
    }
  }

  // 3. 會員等級與購物金規則 (Loyalty & Tiers)
  console.log('✓ 設定會員等級與購物金機制...');
  await runtime.commands.execute(
    'commerce.loyalty.updateRewardSettings',
    {
      accrualBasisPoints: 500, // 5% 回饋
      effectiveAfterDays: 0,
      expiresAfterDays: 365,
      expiryNoticeDays: 30,
    },
    { actor: SEED_ACTOR, idempotencyKey: 'seed-loyalty-settings' },
  );

  const tiers = [
    { name: '一般會員', thresholdPoints: 0, multiplierBasisPoints: 10_000 },
    { name: '銀卡', thresholdPoints: 3_000, multiplierBasisPoints: 12_000 },
    { name: '金卡', thresholdPoints: 10_000, multiplierBasisPoints: 15_000 },
    { name: '黑卡 VIP', thresholdPoints: 20_000, multiplierBasisPoints: 20_000 },
  ];

  for (const tier of tiers) {
    await runtime.commands.execute(
      'commerce.loyalty.saveTier',
      tier,
      { actor: SEED_ACTOR, idempotencyKey: `seed-tier-${tier.name}` },
    );
    console.log(`  ✓ 會員等級: ${tier.name} (門檻 ${tier.thresholdPoints} 點 / ${(tier.multiplierBasisPoints / 10_000).toFixed(1)}x)`);
  }

  // 4. 促銷活動 (Promotions)
  console.log('✓ 建立促銷活動...');
  let welcomePromoId: string | null = null;
  let kolPromoId: string | null = null;

  try {
    const p1 = await runtime.commands.execute<any>(
      'commerce.promotion.createPromotion',
      {
        name: '全站滿額現折 $200',
        status: 'active',
        rule: {
          type: 'threshold_fixed_amount',
          thresholdCents: 200_000, // 滿 $2,000
          discountCents: 20_000,   // 折 $200
        },
        priority: 10,
        stackable: true,
        requiresCoupon: false,
        tierNames: [],
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-promo-threshold' },
    );
    console.log(`  ✓ 促銷活動: ${p1.name}`);
  } catch {}

  try {
    const p2 = await runtime.commands.execute<any>(
      'commerce.promotion.createPromotion',
      {
        name: '新春生活提案季：全單 9 折',
        status: 'active',
        rule: {
          type: 'order_percentage',
          percentOffBasisPoints: 1000, // 10% off (9折)
          maxDiscountCents: 100_000,
        },
        priority: 20,
        stackable: false,
        requiresCoupon: false,
        tierNames: [],
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-promo-percentage' },
    );
    console.log(`  ✓ 促銷活動: ${p2.name}`);
  } catch {}

  try {
    const p3 = await runtime.commands.execute<any>(
      'commerce.promotion.createPromotion',
      {
        name: '新會員首購迎賓折 $100',
        status: 'active',
        rule: {
          type: 'threshold_fixed_amount',
          thresholdCents: 50_000, // 滿 $500
          discountCents: 10_000,  // 折 $100
        },
        priority: 30,
        stackable: true,
        requiresCoupon: true,
        tierNames: [],
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-promo-welcome' },
    );
    welcomePromoId = p3.id;
    console.log(`  ✓ 促銷活動（需券）: ${p3.name}`);
  } catch {}

  try {
    const p4 = await runtime.commands.execute<any>(
      'commerce.promotion.createPromotion',
      {
        name: 'KOL 風格生活專屬折 $200',
        status: 'active',
        rule: {
          type: 'threshold_fixed_amount',
          thresholdCents: 150_000, // 滿 $1,500
          discountCents: 20_000,   // 折 $200
        },
        priority: 40,
        stackable: true,
        requiresCoupon: true,
        tierNames: [],
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-promo-kol' },
    );
    kolPromoId = p4.id;
    console.log(`  ✓ 促銷活動（行銷碼）: ${p4.name}`);
  } catch {}

  // 5. 優惠券 (Coupons)
  console.log('✓ 建立公開優惠碼與行銷碼...');
  if (welcomePromoId) {
    try {
      await runtime.commands.execute(
        'commerce.coupon.createCoupon',
        {
          code: 'WELCOME100',
          promotionId: welcomePromoId,
          kind: 'shared',
          maxRedemptions: 1000,
          perCustomerOnce: true,
        },
        { actor: SEED_ACTOR, idempotencyKey: 'seed-coupon-welcome100' },
      );
      console.log('  ✓ 公開優惠碼: WELCOME100 (首購現折 $100)');
    } catch {}

    try {
      await runtime.commands.execute(
        'commerce.coupon.createCoupon',
        {
          code: 'WOVEN2026',
          promotionId: welcomePromoId,
          kind: 'shared',
          maxRedemptions: 500,
          perCustomerOnce: false,
        },
        { actor: SEED_ACTOR, idempotencyKey: 'seed-coupon-woven2026' },
      );
      console.log('  ✓ 季節折扣碼: WOVEN2026');
    } catch {}
  }

  if (kolPromoId) {
    try {
      await runtime.commands.execute(
        'commerce.coupon.createCoupon',
        {
          code: 'LIFESTYLE_CARL',
          promotionId: kolPromoId,
          kind: 'marketing',
          partnerCode: 'CARL_STYLE',
          maxRedemptions: 200,
          perCustomerOnce: true,
        },
        { actor: SEED_ACTOR, idempotencyKey: 'seed-coupon-kol' },
      );
      console.log('  ✓ KOL 合作行銷碼: LIFESTYLE_CARL (歸因 CARL_STYLE)');
    } catch {}
  }

  // 6. 商品與庫存 (Products & Stock)
  console.log(`✓ 注入 ${PRODUCTS.length} 件精選商品與庫存...`);
  for (const item of PRODUCTS) {
    let productId: string | undefined;
    try {
      const product = await runtime.commands.execute<{ id: string }>(
        'commerce.catalog.createProduct',
        {
          sku: item.sku,
          name: item.name,
          description: item.description,
          priceCents: item.priceCents,
          currency: 'TWD',
          status: 'active',
        },
        { actor: SEED_ACTOR, idempotencyKey: `seed-product-${item.sku}` },
      );
      productId = product.id;
    } catch {
      const rows = await runtime.database.db.execute<{ id: string }>(
        sql`SELECT id FROM catalog_products WHERE sku = ${item.sku}`,
      );
      productId = rows.rows[0]?.id;
    }

    if (productId && item.stock > 0) {
      try {
        await runtime.commands.execute(
          'commerce.inventory.adjustStock',
          {
            productId,
            delta: item.stock,
            reason: 'restock',
            reference: '初始首發進貨',
          },
          { actor: SEED_ACTOR, idempotencyKey: `seed-stock-${item.sku}-${item.stock}` },
        );
      } catch {}
    }
    console.log(`  ✓ [${item.sku}] ${item.name} ($${(item.priceCents / 100).toLocaleString()} · 庫存 ${item.stock})`);
  }

  // 7. 示範帳號 (Demo Accounts)
  console.log('✓ 建立示範帳號與會員資料...');

  // 管理員帳號 (Staff)
  try {
    await runtime.database.db.transaction(async (tx) => {
      await accountService.createAccount(tx, {
        email: 'admin@storeweave.test',
        password: 'AdminPassword123!',
        displayName: '織日總部店長',
        role: 'admin',
      });
    });
    console.log('  ✓ 管理員帳號: admin@storeweave.test (密碼: AdminPassword123!)');
  } catch (err) {
    console.error('  ✕ 建立管理員帳號錯誤:', err);
  }

  // 金卡 VIP 顧客
  let vipCustomerId: string | undefined;
  try {
    const vip = await runtime.commands.execute<{ customer: { id: string } }>(
      'commerce.customer.registerCustomer',
      {
        email: 'gold_vip@woven-day.test',
        password: 'CustomerPassword123!',
        displayName: '林雅婷 (金卡 VIP)',
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-customer-vip' },
    );
    vipCustomerId = vip.customer.id;
  } catch {
    const rows = await runtime.database.db.execute<{ id: string }>(
      sql`SELECT c.id FROM customer_profiles c JOIN platform_users u ON c.account_id = u.id WHERE u.email = 'gold_vip@woven-day.test'`,
    );
    vipCustomerId = rows.rows[0]?.id;
  }

  if (vipCustomerId) {
    try {
      await runtime.commands.execute(
        'commerce.loyalty.adjustReward',
        {
          customerId: vipCustomerId,
          amountCents: 65_000,
          reason: 'VIP 會員年度回饋禮遇',
        },
        { actor: SEED_ACTOR, idempotencyKey: 'seed-vip-rewards-v1' },
      );
    } catch {}

    try {
      await runtime.commands.execute(
        'commerce.loyalty.adjustTierPoints',
        {
          customerId: vipCustomerId,
          points: 8_500,
          reason: '過往年度累積消費積分',
        },
        { actor: SEED_ACTOR, idempotencyKey: 'seed-vip-points-v1' },
      );
    } catch {}
    console.log('  ✓ 金卡 VIP 會員: gold_vip@woven-day.test (密碼: CustomerPassword123! · 購物金 $650 · 積分 8,500)');
  }

  // 一般示範顧客
  try {
    await runtime.commands.execute(
      'commerce.customer.registerCustomer',
      {
        email: 'alice@example.com',
        password: 'CustomerPassword123!',
        displayName: '陳愛莉',
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-customer-alice' },
    );
    console.log('  ✓ 一般會員: alice@example.com (密碼: CustomerPassword123!)');
  } catch {}


  // 品牌內容：品牌故事、生活誌、最新消息與常見問題
  let brandPublished = 0;
  for (const article of BRAND_ARTICLES) {
    try {
      const created = await runtime.commands.execute<{ id: string }>(
        'commerce.content.createArticle',
        {
          kind: article.kind, slug: article.slug, title: article.title, summary: article.summary,
          section: article.section, body: article.body.map((block) => ({ ...block })),
          imageKey: article.imageKey, position: article.position,
        },
        { actor: SEED_ACTOR, idempotencyKey: `seed-content-${article.kind}-${article.slug}` },
      );
      await runtime.commands.execute(
        'commerce.content.publishArticle',
        { id: created.id },
        { actor: SEED_ACTOR, idempotencyKey: `seed-content-publish-${article.kind}-${article.slug}` },
      );
      brandPublished += 1;
    } catch (err) {
      // 重跑 seed 時 slug 已存在是正常的；其他原因要看得見，否則整批沒進去也沒人知道。
      const message = err instanceof Error ? err.message : String(err);
      if (!/already used/.test(message)) console.warn(`  ! 品牌內容 ${article.kind}/${article.slug} 未建立: ${message}`);
    }
  }
  // 重跑時冪等鍵會讓 command 重播回原本的結果，所以這是「確保已發布」的篇數，
  // 不是「這一次新建」的篇數——寫成後者在第二次執行就是假的。
  console.log(`  ✓ 品牌內容: 已確保 ${brandPublished} / ${BRAND_ARTICLES.length} 篇為發布狀態（品牌故事、生活誌、最新消息、常見問題）`);

  console.log('\n🎉 StoreWeave 完整 Demo 資料注入完成！');
}


/**
 * 織日選物的品牌內容。這些文字在 ADR 0033 之前寫死在 Theme 裡，
 * 現在是 content 模組的資料——店家改得動，Theme 只負責呈現。
 */
const BRAND_ARTICLES = [
  {
    kind: 'story', slug: 'woven-day', section: '織日選物 · Woven Day', position: 0, imageKey: 'story',
    title: '為日常，採集一點剛好的溫度。',
    summary: '我們從每天會碰觸、會使用、也會被留下的事物開始。不是為了把空間佈置得更滿，而是希望讓生活裡常見的一刻，多一點從容。',
    body: [
      { heading: null, text: '織日選物為桌面、餐桌與起居留下值得反覆使用的器物與織物。我們相信，生活的質地不在於填滿，而在於留下恰好的選擇。' },
      { heading: '從手邊開始', text: '一只杯、一塊布、一張托盤，常常比想像中更接近生活的核心。我們把注意力放在這些反覆出現的小事，讓選擇回到使用本身。' },
      { heading: '替留白保留位置', text: '好的物件不需要搶走空間的聲音。它可以安靜地陪伴餐桌、窗邊與工作桌，讓光線、時間與人的習慣自然形成自己的樣子。' },
      { heading: '把使用看得更久', text: '我們喜歡會隨著日常留下痕跡的東西。當一件物件被持續使用，它不只屬於某個時刻，也慢慢長成每個人的生活記憶。' },
    ],
  },
  {
    kind: 'journal', slug: 'room-for-the-table', section: '日常提案', position: 0, imageKey: 'journal-room',
    title: '為桌面留一塊空白',
    summary: '不必每次都從添購開始。把最常使用的物件留在手邊，讓桌面成為可以慢下來的一小段地方。',
    body: [
      { heading: null, text: '桌面是一天裡最容易被事情填滿的地方：待辦、訊息、餐具、工作與零碎的心思都會暫時落在這裡。留下一小塊空白，並不是要讓生活變得過度整齊，而是替下一個動作保留餘裕。' },
      { heading: null, text: '從一件會反覆使用的器物開始就好。把它放在順手的位置，觀察它如何參與早晨、午餐或傍晚。當物件有了固定的位置，空間也會開始長出自己的節奏。' },
      { heading: null, text: '選物的意義不在於擁有更多，而是在每一次使用時，都能感覺到這件東西剛好適合留下來。' },
    ],
  },
  {
    kind: 'journal', slug: 'objects-and-time', section: '選物筆記', position: 1, imageKey: 'journal-pause',
    title: '讓物件與時間一起生活',
    summary: '真正被留下的物件，往往不是因為它完美無瑕，而是它在一次次日常裡變得熟悉。',
    body: [
      { heading: null, text: '我們喜歡物件被使用後留下的細微變化：一個總是被拿起的杯把、一塊洗過幾次後更柔軟的布，或是餐桌上漸漸熟悉的擺放方式。它們不需要被刻意紀錄，卻能讓日常有了辨識度。' },
      { heading: null, text: '挑選時，先想像它會在哪個片刻出現：早餐的光線裡、朋友來訪前，或是一個人工作的下午。這個問題比風格名稱更接近真正的需要。' },
      { heading: null, text: '當一件物件能自然地進入生活，它就不只是擺設，而是時間留在家裡的一種方式。' },
    ],
  },
  {
    kind: 'journal', slug: 'a-quieter-home', section: '空間片刻', position: 2, imageKey: 'journal-occasion',
    title: '把家留得安靜一點',
    summary: '從光線、觸感與常用物件出發，為每天的起居留下一個不必急著完成的角落。',
    body: [
      { heading: null, text: '家不必在一夜之間被佈置完成。比起追趕某種風格，更值得的是讓空間隨著生活慢慢長出樣子。' },
      { heading: null, text: '先整理一個最常停留的角落：讓桌面只留下會使用的物件，讓一塊織物或一盞燈承接光線，然後暫時不要急著補上其他東西。' },
      { heading: null, text: '安靜不是空無一物，而是每件留下來的東西都有它被需要的理由。' },
    ],
  },
  {
    kind: 'news', slug: 'holiday-shipping', section: '出貨公告', position: 0, imageKey: null,
    title: '連假期間的出貨安排',
    summary: '連假期間倉庫暫停作業，出貨會順延一個工作天。',
    body: [
      { heading: null, text: '連假期間倉庫暫停作業。假期內成立的訂單會在收假後的第一個工作日依下單順序陸續出貨，超商取貨的到店通知也會順延。' },
      { heading: null, text: '若你的訂單有指定的使用時間，歡迎先寫訊息告訴我們，我們會盡量提前安排。' },
    ],
  },
  {
    kind: 'news', slug: 'new-arrival-pottery', section: '新品上架', position: 1, imageKey: 'journal-occasion',
    title: '陶器系列補貨與新色上架',
    summary: '長期缺貨的陶杯回來了，同時多了兩個新的釉色。',
    body: [
      { heading: null, text: '陶器系列這一批補了長期缺貨的品項，也加入兩個新的釉色。每一只都是手工上釉，顏色與紋理會有些微差異，那是它本來的樣子。' },
      { heading: null, text: '數量有限，售完後的下一批要等窯期，我們會在最新消息更新。' },
    ],
  },
  {
    kind: 'faq', slug: 'shipping-time', section: '出貨與配送', position: 0, imageKey: null,
    title: '下單後多久會出貨？',
    summary: '',
    body: [{ heading: null, text: '一般訂單會在付款完成後的一到兩個工作日內出貨。宅配約再一到兩天送達，超商取貨到店約兩到三天，到店後會收到通知簡訊。' }],
  },
  {
    kind: 'faq', slug: 'shipping-fee', section: '出貨與配送', position: 1, imageKey: null,
    title: '運費怎麼算？有免運嗎？',
    summary: '',
    body: [{ heading: null, text: '運費依你選擇的運送方式而定，結帳頁會顯示這一筆訂單的實際金額。達到免運門檻時，運費會自動歸零；折扣與購物金折抵不會用在運費上。' }],
  },
  {
    kind: 'faq', slug: 'returns', section: '退換貨', position: 2, imageKey: null,
    title: '收到商品後可以退換貨嗎？',
    summary: '',
    body: [
      { heading: null, text: '商品送達後七天內，在保持完整、可再販售的狀態下都可以申請退貨。到「我的訂單」找到該筆訂單就能提出申請，我們會回覆後續的寄回方式。' },
      { heading: null, text: '手工製品的釉色、織紋與尺寸會有些微差異，這屬於材質本身的特性，不算瑕疵。若你收到的商品有破損，請直接寫訊息給我們。' },
    ],
  },
  {
    kind: 'faq', slug: 'reward-points', section: '會員與購物金', position: 3, imageKey: null,
    title: '購物金和等級積分有什麼不同？',
    summary: '',
    body: [
      { heading: null, text: '購物金可以在結帳時折抵商品金額，每一批都有自己的有效期限；等級積分只用來決定會員等級，不能折抵金額。' },
      { heading: null, text: '等級積分以滾動十二個月計算，因此會隨時間變動。兩者的明細都可以在「購物金與等級」頁面查到。' },
    ],
  },
] as const;

async function main() {
  const configPath = process.env.COMMERCE_CONFIG ?? (
    existsSync(resolve('deployments/example-store/commerce.yaml'))
      ? resolve('deployments/example-store/commerce.yaml')
      : undefined
  );

  const { runtime } = await bootstrap({
    configPath,
    loggerName: 'storeweave-seed',
    logDestination: 'stderr',
  });

  try {
    await seed(runtime);
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error('❌ Seed 執行失敗:', err);
  process.exit(1);
});
