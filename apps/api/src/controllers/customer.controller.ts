import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { Anonymous, Public, type AuthenticatedRequest } from '../http/auth';
import { startSession } from '../http/session-start';
import { RUNTIME, type Runtime } from '../tokens';

interface RegisterBody {
  email?: string;
  password?: string;
  displayName?: string;
}

@Controller('api/v1/customers')
export class CustomerController extends BusController {
  constructor(@Inject(RUNTIME) runtime: Runtime) {
    super(runtime);
  }

  /**
   * 註冊完直接發 session：讓人註冊完再自己登入一次，只是把同一組密碼多送一次。
   * 強制匿名——註冊時身分還不存在，帶著別人的 cookie 也不該影響結果。
   */
  @Public()
  @Anonymous()
  @Post('register')
  @HttpCode(201)
  async register(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const registered = await this.command<{ customer: { id: string; displayName: string }; email: string }>(
      req,
      'commerce.customer.registerCustomer',
      body,
    );

    const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
      email: registered.email,
      password: body.password!,
    });
    const cartNotice = await startSession(this.runtime, req, reply, session);

    return ok({
      id: registered.customer.id,
      email: registered.email,
      displayName: registered.customer.displayName,
      cartNotice,
    });
  }

  @Get('me')
  async me(@Req() req: AuthenticatedRequest) {
    return ok(await this.query(req, 'commerce.customer.getMyProfile', {}));
  }

  @Patch('me')
  async updateMe(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return ok(await this.command(req, 'commerce.customer.updateMyProfile', body));
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return ok(await this.query(req, 'commerce.customer.listCustomers', {
      q: query.q, status: query.status, limit: query.limit, offset: query.offset,
    }));
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.customer.getCustomer', { id }));
  }

  @Get(':id/loyalty')
  async loyalty(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return ok(await this.query(req, 'commerce.loyalty.getCustomerLoyalty', { customerId: id }));
  }

  /** 客服補償：增減購物金。金額與原因都會進帳本與稽核紀錄。 */
  @Post(':id/rewards')
  async adjustRewards(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.loyalty.adjustRewards', {
      customerId: id, amountCents: body.amountCents, reason: body.reason, expiresInDays: body.expiresInDays,
    }));
  }

  /** 客服補償：增減等級積分。它不能折抵金額，只影響等級。 */
  @Post(':id/tier-points')
  async adjustTierPoints(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.loyalty.adjustTierPoints', {
      customerId: id, points: body.points, reason: body.reason,
    }));
  }

  @Post(':id/status')
  async setStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return ok(await this.command(req, 'commerce.customer.setCustomerStatus', { customerId: id, status: body.status }));
  }
}
