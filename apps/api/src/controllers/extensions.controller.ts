import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { PlatformError } from '@storeweave/contracts';
import { BusController } from './base';
import { ok } from '../http/envelope';
import type { AuthenticatedRequest } from '../http/auth';

/**
 * Extension 的通用 HTTP 橋接。
 * Core 不需要為任何個別 Extension 增加端點 —— 一律走這裡的 Command / Query Bus。
 */
@Controller('api/v1/extensions')
export class ExtensionsController extends BusController {
  @Get()
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
  async runQuery(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('query') query: string,
    @Query() params: Record<string, string>,
  ) {
    this.assertOwnedBy(id, query);
    return ok(await this.query(req, query, params));
  }

  private assertOwnedBy(extensionId: string, name: string): void {
    const ext = this.runtime.extensions.find(extensionId);
    if (!ext) throw PlatformError.notFound('Extension', extensionId);
    if (!name.startsWith(`ext.${extensionId}.`)) {
      throw PlatformError.validation(`"${name}" does not belong to extension "${extensionId}"`);
    }
  }
}
