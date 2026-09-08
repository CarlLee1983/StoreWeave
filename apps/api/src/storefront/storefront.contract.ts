import type { JsonSchema7Type } from 'zod-to-json-schema';
import type { StorefrontAssetHttpContract, StorefrontHttpContract, StorefrontResponse } from '../http/contract';

const string: JsonSchema7Type = { type: 'string' };
const schema = (fields: readonly string[] = []): JsonSchema7Type => ({
  type: 'object', properties: Object.fromEntries(fields.map(field => [field, string])), additionalProperties: true,
});
// Storefront forms intentionally remain descriptive: URL-encoded, repeated, and JSON bodies keep their existing handler behavior.
const form = (...fields: string[]) => schema(fields);
const query = (...fields: string[]) => schema(fields);
const none = (...params: string[]) => schema(params);
const rmaFormWithNumber = {
  type: 'object', properties: { reason: string, orderLineId: { oneOf: [string, { type: 'array', items: string }] }, number: string },
  patternProperties: { '^quantity_.+$': string }, additionalProperties: true,
} as unknown as JsonSchema7Type;

const html = (status: number | 'platform-error' = 200): StorefrontResponse =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' });
type RedirectLocation = Extract<StorefrontResponse, { kind: 'redirect' }>['location'];
const redirect = (location: RedirectLocation): StorefrontResponse =>
  ({ kind: 'redirect', status: 303, location });
const htmlOnly = (): readonly StorefrontResponse[] => [html(), html('platform-error')];
const plainHtml = (): readonly StorefrontResponse[] => [html()];
const pageOrRedirect = (): readonly StorefrontResponse[] => [html(), html('platform-error'), redirect({ kind: 'server-constructed' })];
const redirectOrError = (location: Parameters<typeof redirect>[0]): readonly StorefrontResponse[] => [html('platform-error'), redirect(location)];
const redirectOrHtml = (status: number, location: Parameters<typeof redirect>[0]): readonly StorefrontResponse[] => [html(status), redirect(location)];
const notice = ['cart-notice-consume'] as const;
const storefront = (contract: Omit<StorefrontHttpContract, 'kind'>): StorefrontHttpContract => ({ kind: 'storefront', ...contract });

export const WOVEN_DAY_ARTWORK = [
  'woven-day-hero.png', 'woven-day-story.png', 'woven-day-journal.png',
  'woven-day-products-pottery.png', 'woven-day-products-textiles.png',
  'woven-day-products-wood.png', 'woven-day-products-living.png',
] as const;

export const storefrontAssetContract: StorefrontAssetHttpContract = {
  kind: 'storefront-asset', request: 'none', input: none('file'), params: { file: 'file' }, allowedFiles: WOVEN_DAY_ARTWORK,
};

export const storefrontContracts = {
  home: storefront({ request: 'query', input: query('q', 'minPrice', 'maxPrice', 'page'), responses: htmlOnly(), cookieEffects: notice }),
  catalog: storefront({ request: 'query', input: query('q', 'minPrice', 'maxPrice', 'page'), responses: htmlOnly(), cookieEffects: notice }),
  story: storefront({ request: 'none', input: none(), responses: htmlOnly(), cookieEffects: notice }),
  journal: storefront({ request: 'none', input: none(), responses: htmlOnly(), cookieEffects: notice }),
  journalArticle: storefront({ request: 'none', input: none('slug'), params: { slug: 'slug' }, responses: htmlOnly(), cookieEffects: notice }),
  news: storefront({ request: 'none', input: none(), responses: htmlOnly(), cookieEffects: notice }),
  newsArticle: storefront({ request: 'none', input: none('slug'), params: { slug: 'slug' }, responses: htmlOnly(), cookieEffects: notice }),
  faq: storefront({ request: 'none', input: none(), responses: htmlOnly(), cookieEffects: notice }),
  contactPage: storefront({ request: 'none', input: none(), responses: [html(), html(404)], cookieEffects: notice }),
  submitContact: storefront({ request: 'form', input: form('name', 'email', 'subject', 'message', 'website'), responses: [html(), html(400), html(404)], cookieEffects: notice }),
  product: storefront({ request: 'none', input: none('id'), params: { id: 'id' }, responses: htmlOnly(), cookieEffects: notice }),
  accountOrders: storefront({ request: 'query', input: query('limit', 'offset'), audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  profilePage: storefront({ request: 'none', input: none(), audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  saveProfile: storefront({ request: 'form', input: form('displayName', 'phone', 'birthday', 'recipient', 'addressPhone', 'postcode', 'city', 'district', 'line1', 'line2'), audience: 'customer', responses: redirectOrHtml(200, { kind: 'server-constructed' }), cookieEffects: notice }),
  order: storefront({ request: 'none', input: none('number'), params: { number: 'number' }, audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  createRma: storefront({ request: 'form', input: rmaFormWithNumber, params: { number: 'number' }, audience: 'customer', responses: redirectOrError({ kind: 'server-constructed' }), cookieEffects: notice }),
  retryPayment: storefront({ request: 'form', rateLimit: 'cart', input: form('number', 'paymentProvider', 'paymentMethod'), params: { number: 'number' }, audience: 'customer', responses: redirectOrError({ kind: 'server-constructed' }), cookieEffects: notice }),
  cancelOrder: storefront({ request: 'none', rateLimit: 'cart', input: none('number'), params: { number: 'number' }, audience: 'customer', responses: redirectOrError({ kind: 'server-constructed' }), cookieEffects: notice }),
  cart: storefront({ request: 'none', input: none(), responses: htmlOnly(), cookieEffects: notice }),
  addToCart: storefront({ request: 'form', rateLimit: 'cart', input: form('productId', 'quantity'), responses: redirectOrError({ kind: 'fixed', value: '/cart' }), cookieEffects: ['guest-cart-ensure', ...notice] }),
  setCartItemQuantity: storefront({ request: 'form', rateLimit: 'cart', input: form('productId', 'quantity'), params: { productId: 'productId' }, responses: redirectOrError({ kind: 'fixed', value: '/cart' }), cookieEffects: ['guest-cart-ensure', ...notice] }),
  clearCart: storefront({ request: 'none', rateLimit: 'cart', input: none(), responses: redirectOrError({ kind: 'fixed', value: '/cart' }), cookieEffects: ['guest-cart-ensure', ...notice] }),
  cartCoupon: storefront({ request: 'form', rateLimit: 'coupon', input: form('code', 'remove'), responses: [html(400), html('platform-error'), redirect({ kind: 'fixed', value: '/cart' })], cookieEffects: ['guest-cart-ensure', ...notice] }),
  accountRewards: storefront({ request: 'none', input: none(), audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  accountCoupons: storefront({ request: 'none', input: none(), audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  cartRewards: storefront({ request: 'form', rateLimit: 'cart', input: form('amount'), audience: 'customer', responses: [
    html('platform-error'), redirect({ kind: 'fixed', value: '/cart' }), redirect({ kind: 'fixed', value: '/login?next=%2Fcart' }),
  ], cookieEffects: notice }),
  checkoutPage: storefront({ request: 'query', input: query('shippingMethodId', 'pickupSelectionToken'), audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  startPickupSelection: storefront({ request: 'form', input: form('cartId', 'shippingMethodId'), audience: 'customer', responses: redirectOrError({ kind: 'server-constructed' }), cookieEffects: notice }),
  pickupStorePicker: storefront({ request: 'query', input: query('token'), audience: 'customer', responses: pageOrRedirect(), cookieEffects: notice }),
  completePickupSelection: storefront({ request: 'form', input: form('token', 'providerStoreId'), auth: 'opaque-capability', responses: redirectOrError({ kind: 'server-constructed' }) }),
  checkout: storefront({ request: 'form', rateLimit: 'cart', input: form('cartId', 'shippingMethodId', 'pickupSelectionToken', 'pickupRecipient', 'pickupPhone', 'recipient', 'phone', 'postcode', 'city', 'district', 'line1', 'line2', 'paymentProvider', 'paymentMethod', 'invoicePreference', 'invoiceCarrierNumber', 'invoiceLoveCode'), audience: 'customer', responses: redirectOrError({ kind: 'server-constructed' }), cookieEffects: notice }),
  forgotPasswordPage: storefront({ request: 'none', input: none(), responses: plainHtml() }),
  forgotPassword: storefront({ request: 'form', rateLimit: 'auth', input: form('email'), responses: plainHtml() }),
  resetPasswordPage: storefront({ request: 'query', input: query('token'), responses: plainHtml() }),
  resetPassword: storefront({ request: 'form', rateLimit: 'auth', input: form('token', 'password'), responses: [html(400), redirect({ kind: 'fixed', value: '/login' })] }),
  loginPage: storefront({ request: 'query', input: query('next'), responses: plainHtml() }),
  registerPage: storefront({ request: 'query', input: query('next'), responses: plainHtml() }),
  login: storefront({ request: 'form', rateLimit: 'auth', input: form('email', 'password', 'next'), responses: [html(401), redirect({ kind: 'validated-same-origin' })], cookieEffects: ['session-start'] }),
  register: storefront({ request: 'form', rateLimit: 'auth', input: form('email', 'password', 'displayName', 'next'), responses: [html(400), redirect({ kind: 'validated-same-origin' })], cookieEffects: ['session-start'] }),
  logout: storefront({ request: 'none', input: none(), responses: [redirect({ kind: 'fixed', value: '/' })], cookieEffects: ['session-clear'] }),
} as const;
