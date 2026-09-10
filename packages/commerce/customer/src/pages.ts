import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, formValue, type PageOutcome, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import type { JsonSchema7Type } from 'zod-to-json-schema';

/** 會員中心「我的資料」頁看到的樣子。 */
export interface ThemeAccountProfileView {
  displayName: string;
  phone: string | null;
  /** 已設定的生日不能自己改，畫面要說得出為什麼。 */
  birthday: string | null;
  address: {
    countryCode: 'TW'; recipient: string; phone: string; postcode: string; city: string; district: string | null;
    line1: string; line2: string | null;
  } | null;
  saved?: boolean;
  error?: string;
}

const jsonSchema = (fields: readonly string[]): JsonSchema7Type => ({
  type: 'object',
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  additionalProperties: true,
} as JsonSchema7Type);

type StorefrontResponse = StorefrontHttpContract['responses'][number];

const html = (status: number | 'platform-error' = 200): StorefrontResponse =>
  ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' });
const redirect = (location: Extract<StorefrontResponse, { kind: 'redirect' }>['location']): StorefrontResponse =>
  ({ kind: 'redirect', status: 303, location });

const saveProfileInput = z.object({
  displayName: formValue.optional(),
  phone: formValue.optional(),
  birthday: formValue.optional(),
  recipient: formValue.optional(),
  addressPhone: formValue.optional(),
  postcode: formValue.optional(),
  city: formValue.optional(),
  district: formValue.optional(),
  line1: formValue.optional(),
  line2: formValue.optional(),
});

async function renderProfile(
  ctx: PageResolveContext,
  extra: { saved?: boolean; error?: string },
): Promise<PageOutcome<ThemeAccountProfileView>> {
  const profile = await ctx.queries.execute<{
    displayName: string; phone: string | null; birthday: string | null; address: ThemeAccountProfileView['address'];
  }>('commerce.customer.getMyProfile', {}, { actor: ctx.actor });
  return {
    kind: 'view',
    view: {
      displayName: profile.displayName,
      phone: profile.phone,
      birthday: profile.birthday,
      address: profile.address,
      ...extra,
    },
  };
}

export const customerPages = {
  profile: definePage({
    id: 'commerce.customer.profile',
    path: '/account/profile',
    method: 'get',
    audience: 'customer',
    input: z.object({}),
    contract: {
      kind: 'storefront', request: 'none', input: jsonSchema([]), audience: 'customer',
      responses: [html(), html('platform-error'), redirect({ kind: 'server-constructed' })],
      cookieEffects: ['cart-notice-consume'],
    },
    resolve: async ctx => renderProfile(ctx, {}),
  }),

  saveProfile: definePage({
    id: 'commerce.customer.saveProfile',
    path: '/account/profile',
    method: 'post',
    audience: 'customer',
    input: saveProfileInput,
    contract: {
      kind: 'storefront', request: 'form',
      input: jsonSchema(['displayName', 'phone', 'birthday', 'recipient', 'addressPhone', 'postcode', 'city', 'district', 'line1', 'line2']),
      audience: 'customer',
      responses: [html(200), redirect({ kind: 'server-constructed' })],
      cookieEffects: ['cart-notice-consume'],
    },
    resolve: async (ctx, body) => {
      const address = body.line1?.trim()
        ? {
            countryCode: 'TW' as const,
            recipient: body.recipient ?? '',
            phone: body.addressPhone ?? '',
            postcode: body.postcode ?? '',
            city: body.city ?? '',
            district: body.district?.trim() || null,
            line1: body.line1,
            line2: body.line2?.trim() ? body.line2 : null,
          }
        : undefined;

      try {
        await ctx.commands.execute('commerce.customer.updateMyProfile', {
          displayName: body.displayName || undefined,
          phone: body.phone?.trim() ? body.phone : undefined,
          birthday: body.birthday?.trim() ? body.birthday : undefined,
          address,
        }, { actor: ctx.actor });
        return renderProfile(ctx, { saved: true });
      } catch (err) {
        const message = err instanceof PlatformError && err.httpStatus < 500 ? err.message : '儲存失敗，請稍後再試。';
        return renderProfile(ctx, { error: message });
      }
    },
  }),
} as const;

export type CustomerPages = typeof customerPages;
