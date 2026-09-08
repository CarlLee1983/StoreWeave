import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { PlatformError, declaredInputKeys } from '@storeweave/contracts';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';
import { HttpContract, type DirectHttpContract, type ExtensionHttpContract } from '../http/contract';
import type { JsonSchema7Type } from 'zod-to-json-schema';

const emptyInput = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema7Type;
const response = (data: JsonSchema7Type) => ({
  type: 'object', required: ['success', 'data'], additionalProperties: false,
  properties: { success: { type: 'boolean', const: true }, data },
} satisfies JsonSchema7Type);
const stringArray = { type: 'array', items: { type: 'string' } } as const satisfies JsonSchema7Type;
const routes = {
  list: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: {
      type: 'object', required: ['id', 'name', 'version', 'platformVersion', 'permissions', 'subscribedEvents', 'commands', 'queries', 'providers', 'mcpTools'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, platformVersion: { type: 'string' },
        permissions: stringArray, subscribedEvents: stringArray, commands: stringArray, queries: stringArray,
        providers: stringArray, mcpTools: stringArray,
      },
    } } },
  }) },
  command: { kind: 'extension-command', request: 'body' },
  query: { kind: 'extension-query', request: 'query', queryExtras: 'drop-and-log-keys' },
} as const satisfies Record<string, DirectHttpContract | ExtensionHttpContract>;

/**
 * Extension 的通用 HTTP 橋接。
 * Core 不需要為任何個別 Extension 增加端點 —— 一律走這裡的 Command / Query Bus。
 */
@Controller('api/v1/extensions')
export class ExtensionsController extends BusController {
  @Get()
  @HttpContract(routes.list)
  list() {
    return ok({
      items: this.runtime.extensions.list().map((ext) => ({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        platformVersion: ext.platformVersion,
        permissions: ext.permissions,
        subscribedEvents: ext.subscribedEvents,
        commands: ext.commands,
        queries: ext.queries,
        providers: ext.providers,
        mcpTools: ext.mcpTools,
      })),
    });
  }

  @Post(':id/commands/:command')
  @HttpCode(200)
  @HttpContract(routes.command)
  async runCommand(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('command') command: string,
    @Body() body: unknown,
  ) {
    this.assertOwnedBy(id, command);
    return ok(await this.command(req, command, body ?? {}));
  }

  @Get(':id/queries/:query')
  @HttpContract(routes.query)
  async runQuery(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('query') query: string,
    @Query() params: Record<string, string>,
  ) {
    this.assertOwnedBy(id, query);
    return ok(await this.query(req, query, this.declaredParams(query, params)));
  }

  /**
   * query string 只把該支 Query 宣告過的鍵往下送。
   *
   * 這一層是 cache-buster、追蹤參數與各種瀏覽器自己加的鍵會出現的地方，呼叫端阻止不了；
   * 整包往下送會讓 strict 的輸入對著 `_t=` 回 400，等於把別人加的東西算到他頭上（工單 51）。
   * 挑欄位的依據是契約自己宣告的鍵——控制器裡另抄一份白名單，下一支 extension 就會忘記更新。
   *
   * Command 的 JSON body 不做這件事：body 裡多出來的鍵一定是呼叫端自己送的，
   * 那正是 ADR 0024 要讓它看得見的情況。
   */
  private declaredParams(name: string, params: Record<string, string>): Record<string, string> {
    // 剝不出鍵的輸入（union、array……）只能整包往下送。Extension Contract Test 的
    // `command / query inputs are a plain object the HTTP bridge can pick keys from`
    // 就是為了讓這條路走不到——真的走到了，行為與收緊前一樣，不會更糟。
    const declared = declaredInputKeys(this.runtime.queries.get(name).descriptor.input);
    if (!declared) return params;

    const kept = Object.entries(params).filter(([key]) => declared.has(key));
    const dropped = Object.keys(params).filter((key) => !declared.has(key));
    if (dropped.length > 0) {
      // 挑掉的鍵要留下痕跡：打錯的 `?limits=10` 會拿到 200 帶預設值，
      // 沒有這行日誌，維運手上就只有「它沒有照我說的做」。只記鍵名，值可能是個人資料。
      this.runtime.logger.warn({ query: name, dropped }, 'dropped query params not declared by the query');
    }
    return Object.fromEntries(kept);
  }

  private assertOwnedBy(extensionId: string, name: string): void {
    const ext = this.runtime.extensions.find(extensionId);
    if (!ext) throw PlatformError.notFound('Extension', extensionId);
    if (!name.startsWith(`ext.${extensionId}.`)) {
      throw PlatformError.validation(`"${name}" does not belong to extension "${extensionId}"`);
    }
  }
}
