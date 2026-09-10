import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { definePage } from '@storeweave/kernel';
import type { StorefrontPage } from '@storeweave/kernel';
import { HTTP_CONTRACT } from '../../apps/api/src/http/contract';
import { createStorefrontController } from '../../apps/api/src/storefront/storefront-routes';

const contract = { kind: 'storefront', request: 'none', input: { type: 'object' }, responses: [] };

const page = (over: Partial<StorefrontPage<any, any>> & Pick<StorefrontPage<any, any>, 'id' | 'path'>) => definePage({
  method: 'get', audience: 'public', input: z.object({}), contract,
  resolve: async () => ({ kind: 'view', view: {} }),
  ...over,
} as StorefrontPage<any, any>);

const deps = (over: Record<string, unknown> = {}) => ({
  theme: { id: 't', name: 'T', optionsSchema: z.object({}), renderers: { 'platform.home': () => '<h1>home</h1>' } },
  buildContext: async () => ({ storeName: 'S', storeId: 's', currency: 'TWD', locale: 'zh-TW', timeZone: 'Asia/Taipei', publicUrl: 'http://x' }),
  resolveContext: () => ({ queries: { execute: vi.fn() }, commands: { execute: vi.fn() }, actor: undefined, locale: 'zh-TW' }),
  ...over,
}) as never;

const replyStub = () => {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const reply = {
    status(code: number) { sent.status = code; return reply; },
    header(name: string, value: string) { sent.headers[name] = value; return reply; },
    type(value: string) { sent.headers['content-type'] = value; return reply; },
    send(body: unknown) { sent.body = body; return reply; },
  };
  return { reply, sent };
};

describe('資料驅動的 storefront 路由', () => {
  it('每個宣告的頁面生成一個帶 Nest metadata 的 handler', () => {
    const Controller = createStorefrontController([
      page({ id: 'platform.home', path: '/' }),
      page({ id: 'commerce.cart.add', path: '/cart/add', method: 'post' }),
    ], deps());

    const methods = Object.getOwnPropertyNames(Controller.prototype).filter(name => name !== 'constructor');
    expect(methods).toHaveLength(2);

    const [home, add] = methods.map(name => Object.getOwnPropertyDescriptor(Controller.prototype, name)!.value);
    expect(Reflect.getMetadata(METHOD_METADATA, home)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, add)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CONTRACT, home)).toBe(contract);
  });

  it('根路徑交給 Nest 正規化，其餘去掉前導斜線', () => {
    const Controller = createStorefrontController([
      page({ id: 'platform.home', path: '/' }),
      page({ id: 'commerce.product.view', path: '/p/:id' }),
    ], deps());

    const paths = Object.getOwnPropertyNames(Controller.prototype)
      .filter(name => name !== 'constructor')
      .map(name => Reflect.getMetadata(PATH_METADATA, Object.getOwnPropertyDescriptor(Controller.prototype, name)!.value));

    expect(paths).toEqual(['/', 'p/:id']);
  });

  it('view 結果交給 theme 對應 id 的 renderer', async () => {
    const Controller = createStorefrontController([page({ id: 'platform.home', path: '/' })], deps());
    const { reply, sent } = replyStub();

    await (new Controller() as Record<string, any>)[Object.getOwnPropertyNames(Controller.prototype)[1]!]({ actor: undefined }, reply);

    expect(sent.status).toBe(200);
    expect(sent.body).toBe('<h1>home</h1>');
    expect(sent.headers['content-type']).toContain('text/html');
  });

  it('redirect 結果走 303，不進 renderer', async () => {
    const Controller = createStorefrontController([
      page({ id: 'platform.home', path: '/', resolve: async () => ({ kind: 'redirect', location: '/cart' }) }),
    ], deps());
    const { reply, sent } = replyStub();

    await (new Controller() as Record<string, any>)[Object.getOwnPropertyNames(Controller.prototype)[1]!]({ actor: undefined }, reply);

    expect(sent.status).toBe(303);
    expect(sent.headers.location).toBe('/cart');
  });

  it('需要顧客身分的頁面，未登入時導向登入並帶回原路徑', async () => {
    const Controller = createStorefrontController([
      page({ id: 'commerce.account.orders', path: '/account/orders', audience: 'customer' }),
    ], deps());
    const { reply, sent } = replyStub();

    await (new Controller() as Record<string, any>)[Object.getOwnPropertyNames(Controller.prototype)[1]!]({ actor: undefined }, reply);

    expect(sent.status).toBe(303);
    expect(sent.headers.location).toBe('/login?next=%2Faccount%2Forders');
  });

  it('顧客身分存在時照常渲染', async () => {
    const renderers = { 'commerce.account.orders': () => '<ul></ul>' };
    const Controller = createStorefrontController([
      page({ id: 'commerce.account.orders', path: '/account/orders', audience: 'customer' }),
    ], deps({ theme: { id: 't', name: 'T', optionsSchema: z.object({}), renderers } }));
    const { reply, sent } = replyStub();

    await (new Controller() as Record<string, any>)[Object.getOwnPropertyNames(Controller.prototype)[1]!](
      { actor: { id: 'c1', type: 'customer', permissions: [] } }, reply,
    );

    expect(sent.status).toBe(200);
    expect(sent.body).toBe('<ul></ul>');
  });
});
