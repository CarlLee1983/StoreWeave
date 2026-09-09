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
      // health check 是 GET，重送安全，所以允許少量重試。
      const result = await httpFor(ctx, 2).request({
        method: 'GET',
        url: `${config.endpoint.replace(/\/$/, '')}/health`,
        headers: authHeaders(ctx),
      });
      return result.ok
        ? { ok: true, message: `HTTP ${result.status}` }
        : { ok: false, message: `${result.reason}: ${result.message}` };
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
  // 推送單據會在遠端建立資料。遠端雖以 reference 去重，但那是遠端的保證，
  // 不是這一層可以宣稱的，所以不自動重送——重試由 job 的 attempt 決定。
  const result = await httpFor(ctx, 1).request({
    method: 'POST',
    url: `${ctx.config.endpoint.replace(/\/$/, '')}/documents`,
    headers: { 'content-type': 'application/json', ...authHeaders(ctx) },
    // 和 Admin payload inspector 共用同一個投影，確保畫面上的 JSON 就是 HTTP body。
    body: JSON.stringify(toErpHttpPayload(doc)),
  });

  if (!result.ok) throw new Error(`ERP push failed (${result.reason}): ${result.message}`);
  // 2xx 就是遠端已經收下了。回 204、空主體或非 JSON 都不能當成失敗——單據已建立，
  // 把它變成 throw 會讓 job 重試，於是同一張單開兩次。
  const acknowledged = parseAcknowledgement(result.body);
  return { accepted: true, remoteId: acknowledged.remoteId ?? acknowledged.id ?? doc.reference };
}

function parseAcknowledgement(body: string): { remoteId?: string; id?: string } {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as { remoteId?: string; id?: string } : {};
  } catch {
    return {};
  }
}

function authHeaders(ctx: ExtensionContext<DemoErpConfig>): Record<string, string> {
  const apiKey = ctx.secret(DEMO_ERP_API_KEY);
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Demo ERP 的端點由營運者在設定裡指定，可能是自架的內網服務，所以允許 http
 * 且不設 host 允許清單。這是這個 Extension 的用途決定的，不是預設政策。
 */
function httpFor(ctx: ExtensionContext<DemoErpConfig>, maxAttempts: number) {
  return ctx.http({
    timeoutMs: ctx.config.timeoutMs, maxAttempts,
    // 這個 Extension 的用途就是連內網自架 ERP，所以明確打開明文 http 與私有位址。
    // 代價是 endpoint 設定的寫入權等同對內網發請求的能力，須以後台權限控管。
    allowInsecureHttp: true, allowPrivateAddresses: true,
  });
}
