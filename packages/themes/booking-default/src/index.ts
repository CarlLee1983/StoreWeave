import { defineTheme, type ThemeContext } from '@storeweave/kernel';
import { escapeHtml, formatMoney } from '@storeweave/i18n';
import type {
  BookingPropertyPages, BookingPropertyView, BookingRoomTypeDetailView, BookingRoomTypeListView,
} from '@storeweave/booking-property';
import type {
  BookingAvailabilityPages, BookingQuote, BookingQuotePageView, BookingSearchFormValues, BookingSearchPageView,
} from '@storeweave/booking-availability';
import { baseTheme, renderBaseLayout } from '@storeweave/theme-base';

const MEDIA_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const bedLabels = {
  single: '單人床',
  double: '雙人床',
  queen: '加大雙人床',
  king: '特大雙人床',
  'sofa-bed': '沙發床',
  bunk: '上下舖',
  other: '其他床型',
} as const;

function addressText(property: BookingPropertyView['property']): string {
  const { address } = property;
  return [address.countryCode, address.postalCode, address.administrativeArea, address.locality,
    address.addressLine1, address.addressLine2]
    .filter((part): part is string => Boolean(part))
    .map(escapeHtml)
    .join(' ');
}

function propertyFacts(property: BookingPropertyView['property']): string {
  return `<dl class="booking-property-facts">
    <div><dt>地址</dt><dd>${addressText(property)}</dd></div>
    <div><dt>入住時間</dt><dd>${escapeHtml(property.checkInTime)}（${escapeHtml(property.timezone)}）</dd></div>
    <div><dt>退房時間</dt><dd>${escapeHtml(property.checkOutTime)}（${escapeHtml(property.timezone)}）</dd></div>
    <div><dt>幣別</dt><dd>${escapeHtml(property.currency)}</dd></div>
    <div><dt>取消政策</dt><dd>入住前 ${escapeHtml(property.defaultPolicy.freeCancellationHoursBeforeCheckIn)} 小時可免費取消</dd></div>
  </dl>`;
}

function beds(roomType: BookingRoomTypeListView['roomTypes'][number]): string {
  if (roomType.beds.length === 0) return '<p>床型資訊尚未提供。</p>';
  const items = roomType.beds.map(bed => `<li>${escapeHtml(bedLabels[bed.type])} × ${escapeHtml(bed.count)}</li>`).join('');
  return `<ul class="booking-beds">${items}</ul>`;
}

function amenities(roomType: BookingRoomTypeListView['roomTypes'][number]): string {
  if (roomType.amenities.length === 0) return '<p>設施資訊尚未提供。</p>';
  return `<ul class="booking-amenities">${roomType.amenities
    .map(amenity => `<li>${escapeHtml(amenity.label)}</li>`).join('')}</ul>`;
}

function media(roomType: BookingRoomTypeDetailView['roomType']): string {
  const assetId = roomType.mediaAssetId;
  if (!assetId || !MEDIA_ASSET_ID.test(assetId)) return '';
  const source = `/booking/media/${encodeURIComponent(assetId)}/preview`;
  return `<figure class="booking-room-image"><img src="${escapeHtml(source)}" alt="${escapeHtml(roomType.name)}" loading="lazy"></figure>`;
}

function renderProperty(ctx: ThemeContext, view: BookingPropertyView): string {
  const { property } = view;
  return renderBaseLayout(ctx, property.name, `
    <article class="booking-property">
      <p class="eyebrow">住宿地點</p>
      <h1>${escapeHtml(property.name)}</h1>
      ${propertyFacts(property)}
      <p><a href="/rooms">瀏覽房型</a></p>
    </article>
  `);
}

function renderRoomTypeList(ctx: ThemeContext, view: BookingRoomTypeListView): string {
  const items = view.roomTypes.map(roomType => `
    <article class="booking-room-card">
      <h2><a href="/rooms/${encodeURIComponent(roomType.id)}">${escapeHtml(roomType.name)}</a></h2>
      ${roomType.description ? `<p>${escapeHtml(roomType.description)}</p>` : ''}
      <p>每房最多入住 ${escapeHtml(roomType.maxOccupancyPerUnit)} 人</p>
      ${beds(roomType)}
      ${amenities(roomType)}
    </article>
  `).join('');
  return renderBaseLayout(ctx, `${view.property.name}｜房型`, `
    <header class="page-heading"><p class="eyebrow">${escapeHtml(view.property.name)}</p><h1>房型</h1></header>
    ${propertyFacts(view.property)}
    <section class="booking-room-list" aria-label="可預訂房型">${items || '<p>目前沒有可預訂的房型。</p>'}</section>
  `);
}

function renderRoomTypeDetail(ctx: ThemeContext, view: BookingRoomTypeDetailView): string {
  const { property, roomType } = view;
  const maximumStay = roomType.maximumStayNights === null
    ? '沒有另設最長住宿晚數'
    : `最多 ${roomType.maximumStayNights} 晚`;
  return renderBaseLayout(ctx, `${roomType.name}｜${property.name}`, `
    <article class="booking-room-detail">
      <p class="eyebrow"><a href="/rooms">${escapeHtml(property.name)}・房型</a></p>
      <h1>${escapeHtml(roomType.name)}</h1>
      ${media(roomType)}
      ${roomType.description ? `<p>${escapeHtml(roomType.description)}</p>` : ''}
      <p>每房最多入住 ${escapeHtml(roomType.maxOccupancyPerUnit)} 人</p>
      ${beds(roomType)}
      ${amenities(roomType)}
      <p>最少入住 ${escapeHtml(roomType.minimumStayNights)} 晚；${escapeHtml(maximumStay)}。</p>
      ${propertyFacts(property)}
    </article>
  `);
}

function formatMinor(amountMinor: number, currency: string, locale: string): string {
  return formatMoney(amountMinor, currency, locale);
}

function renderSearchForm(values: BookingSearchFormValues, message?: string): string {
  const inputs = [
    ['checkInLocalDate', '入住日期', 'date'],
    ['checkOutLocalDate', '退房日期', 'date'],
    ['adults', '成人', 'number'],
    ['children', '兒童', 'number'],
    ['roomCount', '房間數', 'number'],
  ] as const;
  return `<form class="booking-search-form" action="/booking/search" method="get">
    ${message ? `<p class="booking-validation" role="alert">${escapeHtml(message)}</p>` : ''}
    ${inputs.map(([name, label, type]) => {
      const minimum = name === 'roomCount' ? ' min="1"' : type === 'number' ? ' min="0"' : '';
      return `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(values[name])}"${minimum}></label>`;
    }).join('')}
    <button type="submit">搜尋房型</button>
  </form>`;
}

function renderSearch(ctx: ThemeContext, view: BookingSearchPageView): string {
  if (view.kind === 'form' || view.kind === 'validation-error') {
    return renderBaseLayout(ctx, '搜尋住宿', `
      <header class="page-heading"><p class="eyebrow">${escapeHtml(ctx.storeName)}</p><h1>搜尋住宿</h1></header>
      ${renderSearchForm(view.values, view.message)}
    `);
  }
  if (view.kind === 'unavailable') {
    return renderBaseLayout(ctx, '搜尋結果', `
      <header class="page-heading"><p class="eyebrow">${escapeHtml(ctx.storeName)}</p><h1>搜尋結果</h1></header>
      <p class="booking-unavailable" role="status">目前沒有符合條件且可預訂的房型。</p>
      <p><a href="/booking/search">修改搜尋條件</a></p>
    `);
  }

  const items = view.choices.map(({ roomType, quote }) => `
    <article class="booking-search-choice">
      <h2>${escapeHtml(roomType.name)}</h2>
      <p>首晚每房每晚 ${formatMinor(quote.nights[0]!.nightlyPriceMinor, quote.currency, ctx.locale)}</p>
      <p>住宿總額 ${formatMinor(quote.totalMinor, quote.currency, ctx.locale)}</p>
      <form action="/booking/quote" method="get">
        <input type="hidden" name="roomTypeId" value="${escapeHtml(quote.roomTypeId)}">
        <input type="hidden" name="checkInLocalDate" value="${escapeHtml(quote.checkInLocalDate)}">
        <input type="hidden" name="checkOutLocalDate" value="${escapeHtml(quote.checkOutLocalDate)}">
        <input type="hidden" name="adults" value="${escapeHtml(quote.adults)}">
        <input type="hidden" name="children" value="${escapeHtml(quote.children)}">
        <input type="hidden" name="roomCount" value="${escapeHtml(quote.roomCount)}">
        <input type="hidden" name="expectedFingerprint" value="${escapeHtml(quote.fingerprint)}">
        <button type="submit">查看報價</button>
      </form>
    </article>
  `).join('');
  return renderBaseLayout(ctx, '搜尋結果', `
    <header class="page-heading"><p class="eyebrow">${escapeHtml(ctx.storeName)}</p><h1>搜尋結果</h1></header>
    <section class="booking-search-results" aria-label="可預訂房型">${items}</section>
  `);
}

function renderQuoteTerms(quote: BookingQuote, locale: string): string {
  const rows = quote.nights.map(night => `<tr>
    <th scope="row">${escapeHtml(night.localDate)}</th>
    <td>${formatMinor(night.nightlyPriceMinor, quote.currency, locale)}</td>
    <td>${formatMinor(night.nightlyTotalMinor, quote.currency, locale)}</td>
  </tr>`).join('');
  return `<dl class="booking-quote-policy">
    <div><dt>幣別</dt><dd>${escapeHtml(quote.currency)}</dd></div>
    <div><dt>免費取消期限</dt><dd>入住前 ${escapeHtml(quote.cancellationPolicy.freeCancellationHoursBeforeCheckIn)} 小時</dd></div>
    <div><dt>Property 時區</dt><dd>${escapeHtml(quote.cancellationPolicy.propertyTimeZone)}</dd></div>
    <div><dt>入住時間</dt><dd>${escapeHtml(quote.cancellationPolicy.checkInTime)}</dd></div>
  </dl>
  <table class="booking-quote-nights"><thead><tr><th>日期</th><th>每房每晚</th><th>房間數小計</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="booking-quote-total">住宿總額 ${formatMinor(quote.totalMinor, quote.currency, locale)}</p>
  <p class="booking-quote-fingerprint">報價識別碼 <code>${escapeHtml(quote.fingerprint)}</code></p>`;
}

function renderQuote(ctx: ThemeContext, view: BookingQuotePageView): string {
  if (view.kind === 'unavailable') {
    return renderBaseLayout(ctx, '報價已無法使用', `
      <header class="page-heading"><p class="eyebrow">${escapeHtml(ctx.storeName)}</p><h1>目前無法提供報價</h1></header>
      <p class="booking-unavailable" role="status">此房型在所選日期目前無法預訂。</p>
      <p><a href="/booking/search">重新搜尋</a></p>
    `);
  }
  if (view.kind === 'validation-error') {
    return renderBaseLayout(ctx, '報價資料有誤', `
      <header class="page-heading"><p class="eyebrow">${escapeHtml(ctx.storeName)}</p><h1>請檢查報價資料</h1></header>
      <p class="booking-validation" role="alert">${escapeHtml(view.message)}</p>
      <p><a href="/booking/search">重新搜尋</a></p>
    `);
  }
  const refreshed = view.kind === 'refreshed';
  return renderBaseLayout(ctx, refreshed ? '報價已更新' : '目前報價', `
    <article class="booking-quote ${refreshed ? 'booking-quote-refreshed' : 'booking-quote-current'}">
      <header class="page-heading"><p class="eyebrow">${escapeHtml(ctx.storeName)}</p><h1>${refreshed ? '報價已更新' : '目前報價'}</h1></header>
      ${refreshed ? '<p class="booking-quote-refresh" role="alert">目前條款與您先前查看的報價不同，請重新確認以下內容後再繼續。</p>' : ''}
      ${renderQuoteTerms(view.quote, ctx.locale)}
    </article>
  `);
}

export const bookingDefaultTheme = defineTheme<BookingPropertyPages & BookingAvailabilityPages>({
  id: 'booking-default',
  name: 'Booking Default',
  optionsSchema: baseTheme.optionsSchema,
  renderers: {
    ...baseTheme.renderers,
    'platform.error': baseTheme.renderers['platform.error'],
    'booking.property.property': renderProperty,
    'booking.property.roomTypes': renderRoomTypeList,
    'booking.property.roomType': renderRoomTypeDetail,
    'booking.availability.search': renderSearch,
    'booking.availability.quote': renderQuote,
  },
});

export default bookingDefaultTheme;
