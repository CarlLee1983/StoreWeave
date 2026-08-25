import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
      neverExpires: false,
      expiryNoticeDays: 30,
    },
    { actor: SEED_ACTOR, idempotencyKey: 'seed-loyalty-settings' },
  );

  const tiers = [
    { name: '織日會員', thresholdPoints: 0, multiplier: 1.0 },
    { name: '銀卡會員', thresholdPoints: 3_000, multiplier: 1.2 },
    { name: '金卡會員', thresholdPoints: 8_000, multiplier: 1.5 },
    { name: '黑卡 VIP', thresholdPoints: 20_000, multiplier: 2.0 },
  ];

  for (const tier of tiers) {
    await runtime.commands.execute(
      'commerce.loyalty.saveTier',
      tier,
      { actor: SEED_ACTOR, idempotencyKey: `seed-tier-${tier.name}` },
    );
    console.log(`  ✓ 會員等級: ${tier.name} (門檻 ${tier.thresholdPoints} 點 / ${tier.multiplier}x)`);
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

      if (item.stock > 0) {
        await runtime.commands.execute(
          'commerce.inventory.adjustStock',
          {
            productId: product.id,
            delta: item.stock,
            reason: '初始首發進貨',
          },
          { actor: SEED_ACTOR, idempotencyKey: `seed-stock-${item.sku}` },
        );
      }
      console.log(`  ✓ [${item.sku}] ${item.name} ($${(item.priceCents / 100).toLocaleString()} · 庫存 ${item.stock})`);
    } catch (err: any) {
      if (!err.message?.includes('already exists')) {
        console.warn(`  ⚠️ 商品 ${item.sku} 建立提示:`, err.message);
      }
    }
  }

  // 7. 示範帳號 (Demo Accounts)
  console.log('✓ 建立示範帳號與會員資料...');

  // 管理員帳號 (Staff)
  try {
    await runtime.db.transaction(async (tx) => {
      await accountService.createAccount(tx, {
        email: 'admin@storeweave.test',
        password: 'AdminPassword123!',
        displayName: '織日總部店長',
        role: 'admin',
      });
    });
    console.log('  ✓ 管理員帳號: admin@storeweave.test (密碼: AdminPassword123!)');
  } catch {}

  // 金卡 VIP 顧客
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

    // 賦予初始購物金 $650 與 8,500 點等級積分
    await runtime.commands.execute(
      'commerce.loyalty.adjustReward',
      {
        customerId: vip.customer.id,
        amountCents: 65_000,
        reason: 'VIP 會員年度回饋禮遇',
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-vip-rewards' },
    );

    await runtime.commands.execute(
      'commerce.loyalty.adjustTierPoints',
      {
        customerId: vip.customer.id,
        points: 8_500,
        reason: '過往年度累積消費積分',
      },
      { actor: SEED_ACTOR, idempotencyKey: 'seed-vip-points' },
    );
    console.log('  ✓ 金卡 VIP 會員: gold_vip@woven-day.test (密碼: CustomerPassword123! · 購物金 $650 · 積分 8,500)');
  } catch {}

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

  console.log('\n🎉 StoreWeave 完整 Demo 資料注入完成！');
}

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
