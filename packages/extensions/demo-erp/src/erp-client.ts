import { createHash } from 'node:crypto';
import type { ErpDocument, ErpProvider, ExtensionContext } from '@storeweave/extension-sdk';
import { DEMO_ERP_API_KEY, ERP_PROVIDER_ID, type DemoErpConfig } from './config';
import { toErpHttpPayload } from './transform';

interface RemoteRecord {
  remoteId: string;
  acceptedAt: string;
}

/**
 * Demo ERP Provider。
 * `mock://` 端點用 Extension 自己的儲存模擬遠端系統，包含以 reference 去重與可設定的暫時性失敗。
 */
export function createDemoErpProvider(ctx: ExtensionContext<DemoErpConfig>): ErpProvider {
  const config = ctx.config;

  return {
    id: ERP_PROVIDER_ID,
    kind: 'erp',

    async push(doc: ErpDocument) {
      if (config.endpoint.startsWith('mock://')) return pushToMock(ctx, doc);
      return pushToHttp(ctx, doc);
    },

    async healthCheck() {
      if (config.endpoint.startsWith('mock://')) {
        return { ok: true, message: `mock endpoint ${config.endpoint}` };
      }
      try {
        const response = await fetchWithTimeout(`${config.endpoint.replace(/\/$/, '')}/health`, {
          method: 'GET',
          headers: authHeaders(ctx),
        }, config.timeoutMs);
        return { ok: response.ok, message: `HTTP ${response.status}` };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    },
  };
}

async function pushToMock(ctx: ExtensionContext<DemoErpConfig>, doc: ErpDocument) {
  const key = `remote:${doc.reference}`;
  const existing = await ctx.store.get<RemoteRecord>(key);
  if (existing) {
    // 遠端系統以 reference 去重：重送不會產生第二張單據
    return { accepted: true, remoteId: existing.remoteId, message: 'duplicate ignored by remote' };
  }

  if (ctx.config.simulateTransientFailures > 0) {
    const failKey = `remote-failures:${doc.reference}`;
    const seen = await ctx.store.mutate<number>(failKey, (current) => (current ?? 0) + 1);
    if (seen <= ctx.config.simulateTransientFailures) {
      throw new Error(`simulated transient ERP failure ${seen}/${ctx.config.simulateTransientFailures}`);
    }
  }

  const remoteId = `ERP-${createHash('sha1').update(doc.reference).digest('hex').slice(0, 12).toUpperCase()}`;
  await ctx.store.set<RemoteRecord>(key, { remoteId, acceptedAt: ctx.now().toISOString() });
  return { accepted: true, remoteId };
}

async function pushToHttp(ctx: ExtensionContext<DemoErpConfig>, doc: ErpDocument) {
  const url = `${ctx.config.endpoint.replace(/\/$/, '')}/documents`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(ctx) },
    // 和 Admin payload inspector 共用同一個投影，確保畫面上的 JSON 就是 HTTP body。
    body: JSON.stringify(toErpHttpPayload(doc)),
  }, ctx.config.timeoutMs);

  if (!response.ok) {
    throw new Error(`ERP responded with HTTP ${response.status}`);
  }
  const json = (await response.json().catch(() => ({}))) as { remoteId?: string; id?: string };
  return { accepted: true, remoteId: json.remoteId ?? json.id ?? doc.reference };
}

function authHeaders(ctx: ExtensionContext<DemoErpConfig>): Record<string, string> {
  const apiKey = ctx.secret(DEMO_ERP_API_KEY);
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
