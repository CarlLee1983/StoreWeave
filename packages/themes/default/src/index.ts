import { z } from 'zod';
import type { StorefrontTheme } from '@storeweave/kernel';
import { escapeHtml, formatMoney, layout } from './layout';

/** 忘記密碼與重設密碼：兩張表單長得夠像，共用一支。 */
function renderPasswordForm(
  ctx: Parameters<typeof layout>[0]['ctx'],
  { mode, error, token, notice }: { mode: string; error?: string; token?: string; notice?: string },
): string {
  const forgot = mode === 'forgot-password';
  const body = `
    <h1>${forgot ? '忘記密碼' : '設定新密碼'}</h1>
    ${notice ? `<p class="muted">${escapeHtml(notice)}</p>` : ''}
    ${error ? `<div class="error"><p>${escapeHtml(error)}</p></div>` : ''}
    ${notice && forgot ? '' : `<form method="post" action="${forgot ? '/forgot-password' : '/reset-password'}">
      ${forgot
        ? `<label>電子郵件<input type="email" name="email" required placeholder="you@example.com"></label>`
        : `<input type="hidden" name="token" value="${escapeHtml(token ?? '')}">
           <label>新密碼<input type="password" name="password" required minlength="8"></label>`}
      <button type="submit">${forgot ? '寄出重設連結' : '設定新密碼'}</button>
    </form>`}
    <p class="muted"><a href="/login">回登入</a></p>`;
  return layout({ title: forgot ? '忘記密碼' : '設定新密碼', body, ctx });
}

/** 伺服器渲染的表單以隱藏欄位做 CSRF 雙提交——瀏覽器的原生表單送不出自訂 header。 */
function csrfField(ctx: { csrfToken?: string | null }): string {
  return ctx.csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(ctx.csrfToken)}">` : '';
}

export const defaultThemeOptions = z.object({
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#111827'),
  tagline: z.string().max(120).default(''),
  showSku: z.boolean().default(true),
});

/**
 * 預設 Storefront Theme：NestJS SSR，輸出純 HTML。
 * 沒有 JavaScript 也能完成瀏覽與下單；HTMX 只用來做漸進增強。
 */
export const defaultTheme: StorefrontTheme = {
  id: 'default',
  name: 'Default Storefront',
  optionsSchema: defaultThemeOptions,

  renderHome(ctx, { products }) {
    const cards = products.map((p) => `
      <article class="card">
        <a href="/p/${escapeHtml(p.id)}">
          <h2>${escapeHtml(p.name)}</h2>
          ${ctx.options.showSku !== false ? `<p class="muted">${escapeHtml(p.sku)}</p>` : ''}
          <p class="price">${formatMoney(p.priceCents, p.currency, ctx.locale)}</p>
          <p class="muted">${p.available === null ? '' : p.available > 0 ? `庫存 ${p.available}` : '已售完'}</p>
        </a>
      </article>`).join('');
    const body = products.length
      ? `<div class="grid">${cards}</div>`
      : `<p class="muted">目前沒有上架的商品。</p>`;
    return layout({ title: '商品', body, ctx });
  },

  renderProduct(ctx, { product }) {
    const soldOut = product.available !== null && product.available <= 0;
    const body = `
      <a class="muted" href="/">← 回商品列表</a>
      <h1>${escapeHtml(product.name)}</h1>
      ${ctx.options.showSku !== false ? `<p class="muted">${escapeHtml(product.sku)}</p>` : ''}
      <p class="price">${formatMoney(product.priceCents, product.currency, ctx.locale)}</p>
      ${product.description ? `<p>${escapeHtml(product.description)}</p>` : ''}
      <p class="muted">${product.available === null ? '' : soldOut ? '已售完' : `可售 ${product.available} 件`}</p>
      <form method="post" action="/checkout">
        <input type="hidden" name="productId" value="${escapeHtml(product.id)}">
        ${csrfField(ctx)}
        <label>數量
          <input type="number" name="quantity" value="1" min="1" max="${Math.max(1, product.available ?? 99)}" required>
        </label>
        <button type="submit" ${soldOut ? 'disabled' : ''}>${ctx.customerName ? '立即結帳' : '登入後結帳'}</button>
      </form>`;
    return layout({ title: product.name, body, ctx });
  },

  renderOrder(ctx, { order }) {
    const rows = order.lines.map((l) => `
      <tr>
        <td>${escapeHtml(l.name)}</td>
        <td>${escapeHtml(l.sku)}</td>
        <td>${l.quantity}</td>
        <td>${formatMoney(l.lineTotalCents, order.currency, ctx.locale)}</td>
      </tr>`).join('');
    const paymentNotice = order.status === 'payment_processing'
      ? '<p class="muted">付款處理中；此頁會在重新整理後顯示最新結果。</p>'
      : order.status === 'expired' ? '<p class="muted">付款逾時，已釋放保留庫存。</p>' : '';
    const body = `
      <h1>訂單 ${escapeHtml(order.number)}</h1>
      <p><span class="badge">${escapeHtml(order.status)}</span></p>
      ${paymentNotice}
      <p class="muted">${escapeHtml(order.customerEmail)}</p>
      <table>
        <thead><tr><th>商品</th><th>SKU</th><th>數量</th><th>小計</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3"><strong>總計</strong></td><td><strong>${formatMoney(order.totalCents, order.currency, ctx.locale)}</strong></td></tr></tfoot>
      </table>
      <p><a href="/">繼續購物</a></p>`;
    return layout({ title: `訂單 ${order.number}`, body, ctx });
  },

  renderAccountOrders(ctx, { orders, limit, offset, total }) {
    const rows = orders.map((o) => `
      <tr>
        <td><a href="/orders/${escapeHtml(o.number)}">${escapeHtml(o.number)}</a></td>
        <td><span class="badge">${escapeHtml(o.status)}</span></td>
        <td>${o.lineCount}</td>
        <td>${formatMoney(o.totalCents, o.currency, ctx.locale)}</td>
        <td class="muted">${escapeHtml(o.placedAt.toLocaleDateString(ctx.locale))}</td>
      </tr>`).join('');

    const previous = offset > 0
      ? `<a href="/account/orders?limit=${limit}&offset=${Math.max(0, offset - limit)}">← 上一頁</a>`
      : '';
    const next = offset + limit < total
      ? `<a href="/account/orders?limit=${limit}&offset=${offset + limit}">下一頁 →</a>`
      : '';

    const body = orders.length === 0
      ? `<h1>我的訂單</h1><p class="muted">你還沒有任何訂單。<a href="/">去逛逛</a></p>`
      : `
      <h1>我的訂單</h1>
      <table>
        <thead><tr><th>訂單編號</th><th>狀態</th><th>件數</th><th>總計</th><th>下單時間</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted">共 ${total} 張</p>
      <p>${previous} ${next}</p>`;
    return layout({ title: '我的訂單', body, ctx });
  },

  renderAccountProfile(ctx, { displayName, phone, birthday, address, saved, error }) {
    const field = (label: string, name: string, value: string | null, extra = '') =>
      `<label>${label}<input name="${name}" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
    const body = `
      <h1>個人資料</h1>
      ${saved ? '<p class="muted">已儲存。</p>' : ''}
      ${error ? `<div class="error"><p>${escapeHtml(error)}</p></div>` : ''}
      <form method="post" action="/account/profile">
        ${csrfField(ctx)}
        ${field('顯示名稱', 'displayName', displayName, 'required maxlength="120"')}
        ${field('聯絡電話', 'phone', phone, 'maxlength="40"')}
        ${birthday
          ? `<label>生日<input value="${escapeHtml(birthday)}" disabled></label>
             <p class="muted">生日設定後不能自行修改，需要更正請聯絡客服。</p>`
          : `<label>生日<input type="date" name="birthday"></label>
             <p class="muted">生日只能設定一次，之後要更正需要聯絡客服。</p>`}
        <fieldset>
          <legend>收件地址</legend>
          ${field('收件人', 'recipient', address?.recipient ?? null, 'maxlength="120"')}
          ${field('收件電話', 'addressPhone', address?.phone ?? null, 'maxlength="40"')}
          ${field('郵遞區號', 'postcode', address?.postcode ?? null, 'maxlength="20"')}
          ${field('縣市', 'city', address?.city ?? null, 'maxlength="80"')}
          ${field('地址', 'line1', address?.line1 ?? null, 'maxlength="200"')}
          ${field('地址第二行', 'line2', address?.line2 ?? null, 'maxlength="200"')}
        </fieldset>
        <button type="submit">儲存</button>
      </form>
      <p><a href="/account/orders">我的訂單</a></p>`;
    return layout({ title: '個人資料', body, ctx });
  },

  renderAuth(ctx, { mode, next, error, token, notice }) {
    if (mode === 'forgot-password' || mode === 'reset-password') {
      return renderPasswordForm(ctx, { mode, error, token, notice });
    }
    const login = mode === 'login';
    const body = `
      <h1>${login ? '登入' : '註冊'}</h1>
      ${error ? `<div class="error"><p>${escapeHtml(error)}</p></div>` : ''}
      <form method="post" action="${login ? '/login' : '/register'}">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <label>電子郵件
          <input type="email" name="email" required placeholder="you@example.com">
        </label>
        ${login ? '' : `<label>顯示名稱
          <input type="text" name="displayName" maxlength="120" placeholder="怎麼稱呼你">
        </label>`}
        <label>密碼
          <input type="password" name="password" required minlength="${login ? 1 : 8}">
        </label>
        <button type="submit">${login ? '登入' : '註冊'}</button>
      </form>
      <p class="muted">${login
        ? `還沒有帳號？<a href="/register?next=${encodeURIComponent(next)}">註冊一個</a> · <a href="/forgot-password">忘記密碼</a>`
        : `已經有帳號了？<a href="/login?next=${encodeURIComponent(next)}">登入</a>`}</p>`;
    return layout({ title: login ? '登入' : '註冊', body, ctx });
  },

  renderError(ctx, { status, message }) {
    return layout({
      title: `錯誤 ${status}`,
      body: `<div class="error"><h1>${status}</h1><p>${escapeHtml(message)}</p><p><a href="/">回首頁</a></p></div>`,
      ctx,
    });
  },
};

export * from './layout';
export default defaultTheme;
