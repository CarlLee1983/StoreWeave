/**
 * 原生向量工藝插圖生成器 (Bespoke SVG Craft Artwork Generator)
 * 零外部圖檔依賴、極致輕量、無損高清，為「織日選物」提供具備生活溫度的工藝視覺。
 */

export type CraftCategory = 'pottery' | 'textile' | 'wood' | 'living' | 'general';

export function getProductCategory(sku: string, name: string): CraftCategory {
  const upper = (sku ?? '').toUpperCase();
  const lowerName = (name ?? '').toLowerCase();
  if (upper.includes('POT') || lowerName.includes('陶') || lowerName.includes('盤') || lowerName.includes('碗') || lowerName.includes('杯') || lowerName.includes('器皿') || lowerName.includes('花器')) {
    return 'pottery';
  }
  if (upper.includes('TEX') || upper.includes('LIN') || lowerName.includes('麻') || lowerName.includes('布') || lowerName.includes('巾') || lowerName.includes('織') || lowerName.includes('毯') || lowerName.includes('圍裙')) {
    return 'textile';
  }
  if (upper.includes('WD') || upper.includes('WOD') || lowerName.includes('木') || lowerName.includes('砧板') || lowerName.includes('托盤') || lowerName.includes('匙') || lowerName.includes('筷')) {
    return 'wood';
  }
  if (upper.includes('LIV') || upper.includes('SCENT') || lowerName.includes('香') || lowerName.includes('蠟燭') || lowerName.includes('籃') || lowerName.includes('居家')) {
    return 'living';
  }
  return 'general';
}

export function getCategoryBadge(category: CraftCategory): { label: string; en: string } {
  switch (category) {
    case 'pottery':
      return { label: '日常器皿', en: 'Ceramics & Dining' };
    case 'textile':
      return { label: '手織布品', en: 'Textile & Linen' };
    case 'wood':
      return { label: '木作道具', en: 'Woodcraft' };
    case 'living':
      return { label: '居家香氛', en: 'Living & Scents' };
    default:
      return { label: '工藝選品', en: 'Craft Collection' };
  }
}

function safeIdFor(raw: string): string {
  let hash = 0;
  for (let i = 0; i < (raw || '').length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36) || 'art';
}

export function renderProductArtwork(sku: string, name: string, aspect: 'square' | 'hero' = 'square'): string {
  const category = getProductCategory(sku, name);
  const id = safeIdFor(sku + name);
  const viewBox = aspect === 'hero' ? '0 0 800 500' : '0 0 400 320';
  const width = '100%';
  const height = '100%';

  let innerSvg = '';

  switch (category) {
    case 'pottery': {
      innerSvg = `
        <defs>
          <radialGradient id="pot-glow-${id}" cx="50%" cy="45%" r="65%">
            <stop offset="0%" stop-color="#F5EFE6" />
            <stop offset="60%" stop-color="#EADBCC" />
            <stop offset="100%" stop-color="#D6C2AF" />
          </radialGradient>
          <linearGradient id="clay-grad-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#C49B7A" />
            <stop offset="50%" stop-color="#9E6E4C" />
            <stop offset="100%" stop-color="#7A4E31" />
          </linearGradient>
          <linearGradient id="glaze-grad-${id}" x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%" stop-color="#EFE6DC" stop-opacity="0.9" />
            <stop offset="100%" stop-color="#D8C7B5" stop-opacity="0.3" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#pot-glow-${id})" />
        <circle cx="200" cy="160" r="110" fill="none" stroke="#CBB9A7" stroke-width="1" stroke-dasharray="4 6" opacity="0.6" />
        <circle cx="200" cy="160" r="135" fill="none" stroke="#D8C8B9" stroke-width="0.8" opacity="0.4" />
        
        <g transform="translate(110, 55)">
          <ellipse cx="90" cy="180" rx="75" ry="14" fill="#3D3028" opacity="0.12" />
          <path d="M 25 140 Q 20 80 50 50 Q 70 30 90 30 Q 110 30 130 50 Q 160 80 155 140 Q 135 170 90 170 Q 45 170 25 140 Z" fill="url(#clay-grad-${id})" />
          <path d="M 40 58 Q 65 85 90 65 Q 115 80 140 58 Q 148 90 135 115 Q 110 125 90 115 Q 70 125 45 115 Q 32 90 40 58 Z" fill="url(#glaze-grad-${id})" />
          <ellipse cx="90" cy="30" rx="35" ry="8" fill="#DFD2C4" stroke="#8C5C3D" stroke-width="1.5" />
          <ellipse cx="90" cy="30" rx="28" ry="5" fill="#3B2618" opacity="0.35" />
          <path d="M 45 125 Q 90 138 135 125" fill="none" stroke="#EFE4D6" stroke-width="1" opacity="0.4" />
          <path d="M 52 145 Q 90 156 128 145" fill="none" stroke="#EFE4D6" stroke-width="0.8" opacity="0.3" />
        </g>
        <text x="200" y="285" font-family="'Songti TC', serif" font-size="11" fill="#756254" text-anchor="middle" letter-spacing="3" opacity="0.85">手作陶物 · 淬火成器</text>
      `;
      break;
    }
    case 'textile': {
      innerSvg = `
        <defs>
          <radialGradient id="tex-glow-${id}" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stop-color="#FAF5EE" />
            <stop offset="60%" stop-color="#EFE6DA" />
            <stop offset="100%" stop-color="#E2D4C3" />
          </radialGradient>
          <pattern id="linen-pattern-${id}" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 0 8 L 16 8 M 8 0 L 8 16" stroke="#B8A795" stroke-width="0.8" opacity="0.25" />
            <path d="M 0 0 L 16 16 M 16 0 L 0 16" stroke="#C4B4A3" stroke-width="0.5" opacity="0.15" />
          </pattern>
          <linearGradient id="linen-drape-${id}" x1="0%" y1="0%" x2="100%" y2="80%">
            <stop offset="0%" stop-color="#D5C5B2" />
            <stop offset="50%" stop-color="#BCA893" />
            <stop offset="100%" stop-color="#9E8770" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#tex-glow-${id})" />
        <rect width="100%" height="100%" fill="url(#linen-pattern-${id})" />
        
        <g transform="translate(90, 50)">
          <ellipse cx="110" cy="185" rx="85" ry="15" fill="#3D3028" opacity="0.1" />
          <path d="M 30 140 Q 60 110 110 120 Q 160 110 190 140 L 170 170 Q 110 185 50 170 Z" fill="url(#linen-drape-${id})" />
          <path d="M 40 100 Q 80 75 120 85 Q 160 75 180 100 L 165 135 Q 110 145 55 135 Z" fill="#E8DCD0" stroke="#C2B09D" stroke-width="1" />
          <path d="M 50 65 Q 90 45 130 55 Q 160 45 170 65 L 160 95 Q 110 105 60 95 Z" fill="#D2BEAA" />
          <line x1="50" y1="170" x2="45" y2="185" stroke="#8A745E" stroke-width="1.5" stroke-linecap="round" />
          <line x1="70" y1="175" x2="68" y2="190" stroke="#8A745E" stroke-width="1.5" stroke-linecap="round" />
          <line x1="95" y1="178" x2="95" y2="193" stroke="#8A745E" stroke-width="1.5" stroke-linecap="round" />
          <line x1="120" y1="178" x2="122" y2="193" stroke="#8A745E" stroke-width="1.5" stroke-linecap="round" />
          <line x1="145" y1="174" x2="149" y2="188" stroke="#8A745E" stroke-width="1.5" stroke-linecap="round" />
          <path d="M 50 65 Q 110 80 170 65" fill="none" stroke="#FAF5EF" stroke-width="2" opacity="0.6" />
        </g>
        <text x="200" y="285" font-family="'Songti TC', serif" font-size="11" fill="#756254" text-anchor="middle" letter-spacing="3" opacity="0.85">天然亞麻 · 經緯溫柔</text>
      `;
      break;
    }
    case 'wood': {
      innerSvg = `
        <defs>
          <radialGradient id="wood-glow-${id}" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stop-color="#FBF7F0" />
            <stop offset="60%" stop-color="#EFE3D3" />
            <stop offset="100%" stop-color="#DCCBB7" />
          </radialGradient>
          <linearGradient id="wood-grain-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#9C6644" />
            <stop offset="40%" stop-color="#7F4F24" />
            <stop offset="100%" stop-color="#582F0E" />
          </linearGradient>
          <linearGradient id="wood-top-${id}" x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%" stop-color="#B07D58" />
            <stop offset="100%" stop-color="#8A532B" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#wood-glow-${id})" />
        
        <g transform="translate(200, 150)" opacity="0.25">
          <ellipse cx="0" cy="0" rx="120" ry="70" fill="none" stroke="#7F4F24" stroke-width="1" />
          <ellipse cx="-5" cy="2" rx="90" ry="50" fill="none" stroke="#7F4F24" stroke-width="0.8" />
          <ellipse cx="-8" cy="3" rx="60" ry="32" fill="none" stroke="#7F4F24" stroke-width="0.8" />
          <ellipse cx="-10" cy="4" rx="30" ry="16" fill="none" stroke="#7F4F24" stroke-width="1" />
        </g>
        
        <g transform="translate(95, 65)">
          <ellipse cx="105" cy="155" rx="80" ry="16" fill="#3D2B1F" opacity="0.14" />
          <path d="M 25 110 C 25 70, 185 70, 185 110 L 185 125 C 185 155, 25 155, 25 125 Z" fill="url(#wood-grain-${id})" />
          <ellipse cx="105" cy="108" rx="72" ry="32" fill="url(#wood-top-${id})" stroke="#582F0E" stroke-width="1.2" />
          <ellipse cx="105" cy="110" rx="65" ry="26" fill="#784722" opacity="0.5" />
          <path d="M 55 105 Q 75 112 95 106" fill="none" stroke="#C99B78" stroke-width="1" opacity="0.5" />
          <path d="M 110 108 Q 135 114 155 107" fill="none" stroke="#C99B78" stroke-width="1" opacity="0.5" />
          <path d="M 75 118 Q 105 124 135 117" fill="none" stroke="#DDB896" stroke-width="0.8" opacity="0.4" />
        </g>
        <text x="200" y="285" font-family="'Songti TC', serif" font-size="11" fill="#756254" text-anchor="middle" letter-spacing="3" opacity="0.85">原木手作 · 歲月肌理</text>
      `;
      break;
    }
    case 'living': {
      innerSvg = `
        <defs>
          <radialGradient id="liv-glow-${id}" cx="50%" cy="40%" r="70%">
            <stop offset="0%" stop-color="#FFF8EE" />
            <stop offset="40%" stop-color="#F6E7D2" />
            <stop offset="100%" stop-color="#E2CCA8" />
          </radialGradient>
          <radialGradient id="candle-flame-${id}" cx="50%" cy="60%" r="50%">
            <stop offset="0%" stop-color="#FFFDF0" />
            <stop offset="40%" stop-color="#FCD34D" />
            <stop offset="80%" stop-color="#F97316" />
            <stop offset="100%" stop-color="#C2410C" />
          </radialGradient>
          <linearGradient id="brass-grad-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#E4C580" />
            <stop offset="40%" stop-color="#C59B42" />
            <stop offset="80%" stop-color="#8F6B23" />
            <stop offset="100%" stop-color="#674A11" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#liv-glow-${id})" />
        
        <g transform="translate(115, 45)">
          <ellipse cx="85" cy="180" rx="65" ry="12" fill="#38281D" opacity="0.12" />
          <rect x="45" y="105" width="80" height="70" rx="6" fill="#F4EDE4" stroke="#D3C3B1" stroke-width="1.5" />
          <rect x="42" y="100" width="86" height="10" rx="3" fill="url(#brass-grad-${id})" />
          <ellipse cx="85" cy="105" rx="38" ry="8" fill="#FDE68A" opacity="0.6" />
          <line x1="85" y1="102" x2="85" y2="84" stroke="#3D291C" stroke-width="1.8" stroke-linecap="round" />
          <circle cx="85" cy="74" r="22" fill="#FDE68A" opacity="0.35" />
          <path d="M 85 58 C 76 68 76 78 85 82 C 94 78 94 68 85 58 Z" fill="url(#candle-flame-${id})" />
          <path d="M 125 155 Q 145 130 135 105 Q 120 75 140 45 Q 155 20 145 5" fill="none" stroke="#BA9C7A" stroke-width="1.2" stroke-dasharray="3 4" opacity="0.6" />
          <circle cx="125" cy="155" r="5" fill="url(#brass-grad-${id})" />
        </g>
        <text x="200" y="285" font-family="'Songti TC', serif" font-size="11" fill="#756254" text-anchor="middle" letter-spacing="3" opacity="0.85">謐靜香氛 · 凝光時光</text>
      `;
      break;
    }
    default: {
      innerSvg = `
        <defs>
          <radialGradient id="gen-glow-${id}" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stop-color="#FAF6F0" />
            <stop offset="100%" stop-color="#E8DED2" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#gen-glow-${id})" />
        <circle cx="200" cy="150" r="85" fill="none" stroke="#C5B5A5" stroke-width="1" stroke-dasharray="3 5" />
        <circle cx="200" cy="150" r="55" fill="#E6D7C8" opacity="0.5" />
        <text x="200" y="156" font-family="'Songti TC', serif" font-size="18" fill="#6B5546" text-anchor="middle">織日</text>
        <text x="200" y="285" font-family="'Songti TC', serif" font-size="11" fill="#756254" text-anchor="middle" letter-spacing="3" opacity="0.85">選物良品 · 溫潤常伴</text>
      `;
      break;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" class="craft-artwork" aria-hidden="true">${innerSvg}</svg>`;
}
