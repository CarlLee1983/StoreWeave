/**
 * Theme-owned, non-product visual texture. It deliberately does not infer a
 * product's material, category, or appearance from its name or SKU.
 */
function safeId(value: string): string {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash) + character.charCodeAt(0) | 0;
  return Math.abs(hash).toString(36) || 'mark';
}

export type WovenDayEditorialImage = 'hero' | 'story' | 'journal-room' | 'journal-pause' | 'journal-occasion';

const WOVEN_DAY_EDITORIAL_IMAGES: Record<WovenDayEditorialImage, { file: string; alt: string }> = {
  hero: {
    file: 'woven-day-hero.png',
    alt: '陽光下的木桌、陶杯、亞麻布與枝葉靜物。',
  },
  story: {
    file: 'woven-day-story.png',
    alt: '木桌上放著陶器、筆記本與亞麻布的日常一角。',
  },
  'journal-room': {
    file: 'woven-day-story.png',
    alt: '整理過的木桌上，一只花器、筆記本與亞麻布安靜並置。',
  },
  'journal-pause': {
    file: 'woven-day-hero.png',
    alt: '窗邊的陶杯、枝葉與摺疊亞麻布。',
  },
  'journal-occasion': {
    file: 'woven-day-journal.png',
    alt: '窗邊桌面上的書、陶盤與自然光影。',
  },
};

/**
 * These are campaign/editorial photographs owned by the built-in Woven Day
 * theme. Their filenames are closed over here, so a renderer never turns a
 * store, product, or article input into a public filesystem path.
 */
export function renderWovenDayEditorialImage(
  image: WovenDayEditorialImage,
  loading: 'eager' | 'lazy' = 'lazy',
): string {
  const { file, alt } = WOVEN_DAY_EDITORIAL_IMAGES[image];
  return `<img class="storefront-editorial-image" src="/storefront-assets/${file}" alt="${alt}" width="1536" height="1024" loading="${loading}" decoding="async">`;
}

type WovenDayProductImage = { file: string; position: string };

/**
 * Product photography is intentionally keyed by the stable seed SKU. This
 * keeps the built-in demo's media closed over a known set rather than turning
 * merchant-provided product data into a public asset path.
 */
const WOVEN_DAY_PRODUCT_IMAGES: Record<string, WovenDayProductImage> = {
  'WD-POT-01': { file: 'woven-day-products-pottery.png', position: '0% 0%' },
  'WD-POT-02': { file: 'woven-day-products-pottery.png', position: '50% 0%' },
  'WD-POT-03': { file: 'woven-day-products-pottery.png', position: '100% 0%' },
  'WD-POT-04': { file: 'woven-day-products-pottery.png', position: '0% 50%' },
  'WD-POT-05': { file: 'woven-day-products-pottery.png', position: '50% 50%' },
  'WD-POT-06': { file: 'woven-day-products-pottery.png', position: '100% 50%' },
  'WD-POT-07': { file: 'woven-day-products-pottery.png', position: '0% 100%' },
  'WD-POT-08': { file: 'woven-day-products-pottery.png', position: '50% 100%' },
  'WD-TEX-01': { file: 'woven-day-products-textiles.png', position: '0% 0%' },
  'WD-TEX-02': { file: 'woven-day-products-textiles.png', position: '50% 0%' },
  'WD-TEX-03': { file: 'woven-day-products-textiles.png', position: '100% 0%' },
  'WD-TEX-04': { file: 'woven-day-products-textiles.png', position: '0% 50%' },
  'WD-TEX-05': { file: 'woven-day-products-textiles.png', position: '50% 50%' },
  'WD-TEX-06': { file: 'woven-day-products-textiles.png', position: '100% 50%' },
  'WD-TEX-07': { file: 'woven-day-products-textiles.png', position: '0% 100%' },
  'WD-WD-01': { file: 'woven-day-products-wood.png', position: '0% 0%' },
  'WD-WD-02': { file: 'woven-day-products-wood.png', position: '50% 0%' },
  'WD-WD-03': { file: 'woven-day-products-wood.png', position: '100% 0%' },
  'WD-WD-04': { file: 'woven-day-products-wood.png', position: '0% 50%' },
  'WD-WD-05': { file: 'woven-day-products-wood.png', position: '50% 50%' },
  'WD-WD-06': { file: 'woven-day-products-wood.png', position: '100% 50%' },
  'WD-LIV-01': { file: 'woven-day-products-living.png', position: '0% 0%' },
  'WD-LIV-02': { file: 'woven-day-products-living.png', position: '50% 0%' },
  'WD-LIV-03': { file: 'woven-day-products-living.png', position: '100% 0%' },
};

export function renderWovenDayProductImage(sku: string, size: 'card' | 'hero' = 'card'): string {
  const image = WOVEN_DAY_PRODUCT_IMAGES[sku];
  if (!image) return renderStorefrontArtwork(sku, size);
  return `<div class="storefront-product-image storefront-product-image--${size}" aria-hidden="true" style="background-image:url('/storefront-assets/${image.file}');background-position:${image.position}"></div>`;
}

export function renderStorefrontArtwork(seed: string, size: 'card' | 'hero' = 'card'): string {
  const id = safeId(seed);
  const viewBox = size === 'hero' ? '0 0 720 480' : '0 0 480 360';
  const path = size === 'hero'
    ? '160 250 C280 120 440 360 560 190'
    : '96 220 C184 100 294 305 384 160';
  return `<svg class="storefront-artwork storefront-artwork--${size}" viewBox="${viewBox}" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="wash-${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f7f3ed" />
        <stop offset="1" stop-color="#e7d8c8" />
      </linearGradient>
      <pattern id="thread-${id}" width="26" height="26" patternUnits="userSpaceOnUse">
        <path d="M0 13H26M13 0V26" stroke="currentColor" stroke-opacity=".12" stroke-width="1" />
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#wash-${id})" />
    <rect width="100%" height="100%" fill="url(#thread-${id})" />
    <circle cx="50%" cy="50%" r="31%" fill="none" stroke="#2b2520" stroke-opacity=".16" stroke-width="1" />
    <circle cx="50%" cy="50%" r="21%" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="2" stroke-dasharray="4 8" />
    <path d="M${path}" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="3" stroke-linecap="round" />
  </svg>`;
}
