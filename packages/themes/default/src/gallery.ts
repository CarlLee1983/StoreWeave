/**
 * 高質感生活風格攝影圖庫與極簡線條圖標系統 (High-End Photography & Minimalist Icon System)
 * 精選自然光感、無版權疑慮的職人攝影圖集（Unsplash Curated CDN），全面捨棄 Emoji。
 */

export interface ProductPhoto {
  url: string;
  alt: string;
  category: 'pottery' | 'textile' | 'wood' | 'living';
  badgeEn: string;
  badgeZh: string;
}

export interface JournalArticleData {
  slug: string;
  title: string;
  category: string;
  readTime: string;
  date: string;
  summary: string;
  coverImage: string;
  contentHtml: string;
  relatedSkus: string[];
}

export const BRAND_HERO_IMAGE = 'https://images.unsplash.com/photo-1616046229478-9901c5536a45?auto=format&fit=crop&w=1600&q=80';
export const STORY_HERO_IMAGE = 'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=1600&q=80';
export const CRAFT_POTTERY_IMAGE = 'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80';
export const CRAFT_TEXTILE_IMAGE = 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80';
export const CRAFT_WOOD_IMAGE = 'https://images.unsplash.com/photo-1533090161767-e6ffed986b88?auto=format&fit=crop&w=800&q=80';

export const BENTO_IMAGES = {
  pottery: 'https://images.unsplash.com/photo-1612196808214-b8e1d6145a8c?auto=format&fit=crop&w=800&q=80',
  textile: 'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=800&q=80',
  wood: 'https://images.unsplash.com/photo-1590736969955-71cc94801759?auto=format&fit=crop&w=800&q=80',
};

export const PRODUCT_PHOTOS: Record<string, ProductPhoto> = {
  // 日常器皿 (8 款)
  'WD-POT-01': {
    url: 'https://images.unsplash.com/photo-1610701596007-11502861dcfa?auto=format&fit=crop&w=800&q=80',
    alt: '白陶手作日常平盤',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },
  'WD-POT-02': {
    url: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=800&q=80',
    alt: '炭黑粗陶茶杯雙入組',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },
  'WD-POT-03': {
    url: 'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=800&q=80',
    alt: '霧面米白釉色飯碗',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },
  'WD-POT-04': {
    url: 'https://images.unsplash.com/photo-1590736969955-71cc94801759?auto=format&fit=crop&w=800&q=80',
    alt: '手作雙耳寬口湯缽',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },
  'WD-POT-05': {
    url: 'https://images.unsplash.com/photo-1577937927133-66ef06acdf18?auto=format&fit=crop&w=800&q=80',
    alt: '手吹薄壁玻璃水杯四入組',
    category: 'pottery',
    badgeEn: 'Glassware',
    badgeZh: '日常器皿',
  },
  'WD-POT-06': {
    url: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=800&q=80',
    alt: '質樸柴燒小清酒器組',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },
  'WD-POT-07': {
    url: 'https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?auto=format&fit=crop&w=800&q=80',
    alt: '長石釉日式長條燒物皿',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },
  'WD-POT-08': {
    url: 'https://images.unsplash.com/photo-1581783342308-f792dbdd27c5?auto=format&fit=crop&w=800&q=80',
    alt: '手捏陶作極簡花器',
    category: 'pottery',
    badgeEn: 'Ceramics',
    badgeZh: '日常器皿',
  },

  // 手織布品 (7 款)
  'WD-TEX-01': {
    url: 'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=800&q=80',
    alt: '重磅純麻雙色餐墊組',
    category: 'textile',
    badgeEn: 'Textile',
    badgeZh: '手織布品',
  },
  'WD-TEX-02': {
    url: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80',
    alt: '水洗棉麻十字交叉圍裙',
    category: 'textile',
    badgeEn: 'Textile',
    badgeZh: '手織布品',
  },
  'WD-TEX-03': {
    url: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=800&q=80',
    alt: '蜂巢織紋純棉吸水擦手巾',
    category: 'textile',
    badgeEn: 'Textile',
    badgeZh: '手織布品',
  },
  'WD-TEX-04': {
    url: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=800&q=80',
    alt: '亞麻原色沙發抱枕套',
    category: 'textile',
    badgeEn: 'Living Linen',
    badgeZh: '手織布品',
  },
  'WD-TEX-05': {
    url: 'https://images.unsplash.com/photo-1606760227091-3dd870d97f1d?auto=format&fit=crop&w=800&q=80',
    alt: '手織天然染純棉方巾',
    category: 'textile',
    badgeEn: 'Textile',
    badgeZh: '手織布品',
  },
  'WD-TEX-06': {
    url: 'https://images.unsplash.com/photo-1580301762395-21ce84d00bc6?auto=format&fit=crop&w=800&q=80',
    alt: '大地色系羊毛純棉萬用毯',
    category: 'textile',
    badgeEn: 'Wool & Cotton',
    badgeZh: '手織布品',
  },
  'WD-TEX-07': {
    url: 'https://images.unsplash.com/photo-1507652313519-d4e9174996dd?auto=format&fit=crop&w=800&q=80',
    alt: '輕透水洗亞麻長桌巾',
    category: 'textile',
    badgeEn: 'Linen Table',
    badgeZh: '手織布品',
  },

  // 木作道具 (6 款)
  'WD-WD-01': {
    url: 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=800&q=80',
    alt: '黑胡桃木手作雕刻托盤',
    category: 'wood',
    badgeEn: 'Walnut Wood',
    badgeZh: '木作道具',
  },
  'WD-WD-02': {
    url: 'https://images.unsplash.com/photo-1590736969955-71cc94801759?auto=format&fit=crop&w=800&q=80',
    alt: '櫻桃木溫潤圓形點心盤',
    category: 'wood',
    badgeEn: 'Woodcraft',
    badgeZh: '木作道具',
  },
  'WD-WD-03': {
    url: 'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?auto=format&fit=crop&w=800&q=80',
    alt: '栗木手作料理筷雙入組',
    category: 'wood',
    badgeEn: 'Utensils',
    badgeZh: '木作道具',
  },
  'WD-WD-04': {
    url: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?auto=format&fit=crop&w=800&q=80',
    alt: '柚木原木深口沙拉大盆',
    category: 'wood',
    badgeEn: 'Teak Bowl',
    badgeZh: '木作道具',
  },
  'WD-WD-05': {
    url: 'https://images.unsplash.com/photo-1589118949245-7d38baf380d6?auto=format&fit=crop&w=800&q=80',
    alt: '手工切削奶油抹刀組',
    category: 'wood',
    badgeEn: 'Woodcraft',
    badgeZh: '木作道具',
  },
  'WD-WD-06': {
    url: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?auto=format&fit=crop&w=800&q=80',
    alt: '北美橡木厚切料理砧板',
    category: 'wood',
    badgeEn: 'Oak Board',
    badgeZh: '木作道具',
  },

  // 居家與香氛 (3 款)
  'WD-LIV-01': {
    url: 'https://images.unsplash.com/photo-1602874801007-bd458bb1b8b8?auto=format&fit=crop&w=800&q=80',
    alt: '檜木與雪松天然大豆蠟燭',
    category: 'living',
    badgeEn: 'Scent & Candle',
    badgeZh: '居家香氛',
  },
  'WD-LIV-02': {
    url: 'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?auto=format&fit=crop&w=800&q=80',
    alt: '實心黃銅手工線香座',
    category: 'living',
    badgeEn: 'Brass Object',
    badgeZh: '居家香氛',
  },
  'WD-LIV-03': {
    url: 'https://images.unsplash.com/photo-1595341888016-a392ef81b7de?auto=format&fit=crop&w=800&q=80',
    alt: '手工草編提把收納籃',
    category: 'living',
    badgeEn: 'Living Basket',
    badgeZh: '居家香氛',
  },
};

export function getProductPhoto(sku: string, name: string): ProductPhoto {
  if (PRODUCT_PHOTOS[sku]) return PRODUCT_PHOTOS[sku];
  // 依名稱特徵回退
  const upper = sku.toUpperCase();
  if (upper.includes('POT') || name.includes('陶') || name.includes('盤') || name.includes('碗') || name.includes('杯')) {
    return PRODUCT_PHOTOS['WD-POT-01'];
  }
  if (upper.includes('TEX') || upper.includes('LIN') || name.includes('麻') || name.includes('布') || name.includes('巾') || name.includes('毯')) {
    return PRODUCT_PHOTOS['WD-TEX-01'];
  }
  if (upper.includes('WD') || upper.includes('WOD') || name.includes('木') || name.includes('托盤') || name.includes('砧板')) {
    return PRODUCT_PHOTOS['WD-WD-01'];
  }
  if (upper.includes('LIV') || name.includes('香') || name.includes('蠟燭') || name.includes('籃')) {
    return PRODUCT_PHOTOS['WD-LIV-01'];
  }
  return {
    url: 'https://images.unsplash.com/photo-1616046229478-9901c5536a45?auto=format&fit=crop&w=800&q=80',
    alt: name,
    category: 'pottery',
    badgeEn: 'Curated Goods',
    badgeZh: '選物精選',
  };
}

export const JOURNAL_ARTICLES: JournalArticleData[] = [
  {
    slug: 'ceramic-care-guide',
    title: '器物日常：如何養出一只溫潤質樸的陶杯？',
    category: '器物保養指南',
    readTime: '5 分鐘閱讀',
    date: '2026 年 8 月',
    summary: '陶器是有呼吸毛孔的天然器皿。初次使用前的「開鍋養器」、日常清洗與避免盛裝深色液體的細心照料，能讓陶杯隨年月生長出專屬你的獨特光澤。',
    coverImage: 'https://images.unsplash.com/photo-1578749556568-bc2c40e68b61?auto=format&fit=crop&w=1200&q=80',
    relatedSkus: ['WD-POT-01', 'WD-POT-02', 'WD-POT-04'],
    contentHtml: `
      <p class="article-lead">器物之所以動人，在於它承載了使用者的時光與生活痕跡。與工業量產的瓷器不同，手作陶器表面具有微細的氣孔與天然礦物結晶，這也是陶器能隨時間「養成」溫潤光澤的原因。</p>
      
      <h2>一、初次使用：以淘米水開鍋</h2>
      <p>初次迎進家門的手作陶皿，建議在正式盛裝料理前進行「開陶」：</p>
      <ol>
        <li>將陶器置於鍋中，倒入完全覆蓋器皿的濃洗米水（或加入一小匙麵粉的水）。</li>
        <li>以小火緩慢加熱至微沸，持續煨煮約 20 分鐘。澱粉質能填補陶器表層微小毛孔，降低日後吸附深色醬汁與油漬的機率。</li>
        <li>關火後靜置待其自然冷卻，取出後以清水洗淨並完全晾乾。</li>
      </ol>

      <h2>二、日常使用與清潔心法</h2>
      <p>日常使用陶杯盛裝黑咖啡、濃茶或紅酒時，若能養成使用後立即沖洗的習慣，便不易殘留茶垢與咖啡漬。清潔時請使用海綿或軟質洗碗布搭配溫水，避免使用鋼絲絨或強酸鹼洗劑，以免刮損手工施釉的細膩表面。</p>

      <h2>三、徹底乾燥，避免潮濕悶放</h2>
      <p>陶器的吸水率高於瓷器，洗淨後請務必倒扣或置於通風處徹底陰乾 1 至 2 天再收入碗櫥，如此便能避免因受潮而產生霉斑，讓一只溫潤質樸的器物陪伴你長長久久。</p>
    `,
  },
  {
    slug: 'linen-interior-styling',
    title: '晨光與亞麻：讓空間自然呼吸的織物佈置學',
    category: '居家空間提案',
    readTime: '4 分鐘閱讀',
    date: '2026 年 8 月',
    summary: '亞麻不只適合盛夏。探索如何利用未經漂染的自然垂墜桌巾、圍裙與雙色餐墊，為室內光線注入柔和濾鏡，打造安定的生活秩序。',
    coverImage: 'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=1200&q=80',
    relatedSkus: ['WD-TEX-01', 'WD-TEX-02', 'WD-TEX-07'],
    contentHtml: `
      <p class="article-lead">在快節奏的都市日常中，我們渴望一處能卸下防備、自在呼吸的居家角落。天然亞麻（Linen）以其粗獷中帶著細膩的纖維紋理，成為連結自然與生活空間最溫柔的介質。</p>

      <h2>一、餐桌上的光影層次</h2>
      <p>鋪上一條大尺寸的水洗亞麻長桌巾，不需刻意熨燙平整，其自然垂墜的微皺感正是亞麻最迷人之處。晨光穿透百葉窗落在麻料織紋上，折射出深淺不一的大地色澤，為平凡的早晨咖啡鋪陳儀式感。</p>

      <h2>二、隨性披掛的起居溫度</h2>
      <p>在客廳沙發或床尾隨意披上一條羊毛純棉萬用毯，搭配兩只亞麻原色抱枕套。不同織度與磅數的織品層疊，能瞬間消弭現代家具的冰冷感，營造如北歐木屋般的安定包覆感。</p>

      <h2>三、越洗越柔軟的生命力</h2>
      <p>天然亞麻具備優異的吸濕排汗與抑菌特質，更棒的是——它是一件「隨歲月越變越美」的織物。經過數十次的水洗與使用，纖維質地會變得無比親膚鬆軟，成為真正屬於你家的生活氣息。</p>
    `,
  },
];

// 極簡幾何線條圖標 (1.25px Monochrome Stroke Icons)
export const ICONS = {
  leaf: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`,
  box: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`,
  shield: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`,
  star: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`,
  arrowRight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
};
