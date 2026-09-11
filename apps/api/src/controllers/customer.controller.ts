import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { HttpContract, type BusHttpContract, type ComposedHttpContract } from '../http/contract';
import { Anonymous, Public, type AuthenticatedRequest } from '../http/auth';
import { HTTP_ADAPTER, type ReleaseHttpAdapter } from '../release-adapter';
import { RUNTIME, type Runtime } from '../tokens';

const routes = {
  me: { kind: 'bus', target: { kind: 'query', name: 'commerce.customer.getMyProfile' }, request: 'none' },
  updateMe: { kind: 'bus', target: { kind: 'command', name: 'commerce.customer.updateMyProfile' }, request: 'body' },
  list: { kind: 'bus', target: { kind: 'query', name: 'commerce.customer.listCustomers' }, request: 'query' },
  get: { kind: 'bus', target: { kind: 'query', name: 'commerce.customer.getCustomer' }, request: 'none', params: { id: 'id' } },
  loyalty: { kind: 'bus', target: { kind: 'query', name: 'commerce.loyalty.getCustomerLoyalty' }, request: 'none', params: { id: 'customerId' } },
  adjustRewards: { kind: 'bus', target: { kind: 'command', name: 'commerce.loyalty.adjustRewards' }, request: 'body', params: { id: 'customerId' } },
  adjustTierPoints: { kind: 'bus', target: { kind: 'command', name: 'commerce.loyalty.adjustTierPoints' }, request: 'body', params: { id: 'customerId' } },
  correctBirthday: { kind: 'bus', target: { kind: 'command', name: 'commerce.customer.setCustomerBirthday' }, request: 'body', params: { id: 'customerId' } },
  setStatus: { kind: 'bus', target: { kind: 'command', name: 'commerce.customer.setCustomerStatus' }, request: 'body', params: { id: 'customerId' } },
} as const satisfies Record<string, BusHttpContract>;

const registerRoute = {
  kind: 'composed', target: { kind: 'command', name: 'commerce.customer.registerCustomer' }, request: 'body', rateLimit: 'auth',
  output: { type: 'object', required: ['id', 'email', 'displayName', 'cartNotice'], properties: {
    id: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' }, cartNotice: { type: ['string', 'null'] },
  } },
} satisfies ComposedHttpContract;

interface RegisterBody {
  email?: string;
  password?: string;
  displayName?: string;
}

@Controller('api/v1/customers')
export class CustomerController extends BusController {
  constructor(
    @Inject(RUNTIME) runtime: Runtime,
    @Inject(HTTP_ADAPTER) private readonly http: ReleaseHttpAdapter,
  ) {
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
  @HttpContract(registerRoute)
  async register(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const registered = await this.command<{ customer: { id: string; displayName: string }; email: string }>(
      req,
      registerRoute.target.name,
      body,
    );

    const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
      email: registered.email,
      password: body.password!,
    });
    const cartNotice = await this.http.startSession(this.runtime, req, reply, session);

    return ok({
      id: registered.customer.id,
      email: registered.email,
      displayName: registered.customer.displayName,
      cartNotice,
    });
  }

  @Get('me')
  @HttpContract(routes.me)
  async me(@Req() req: AuthenticatedRequest) {
    return this.rest(req, routes.me, {});
  }

  @Patch('me')
  @HttpContract(routes.updateMe)
  async updateMe(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.rest(req, routes.updateMe, body);
  }

  @Get()
  @HttpContract(routes.list)
  async list(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    return this.rest(req, routes.list, query);
  }

  @Get(':id')
  @HttpContract(routes.get)
  async get(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.get, {}, params);
  }

  @Get(':id/loyalty')
  @HttpContract(routes.loyalty)
  async loyalty(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>) {
    return this.rest(req, routes.loyalty, {}, params);
  }

  /** 客服補償：增減購物金。金額與原因都會進帳本與稽核紀錄。 */
  @Post(':id/rewards')
  @HttpContract(routes.adjustRewards)
  async adjustRewards(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.adjustRewards, body, params);
  }

  /** 客服補償：增減等級積分。它不能折抵金額，只影響等級。 */
  @Post(':id/tier-points')
  @HttpContract(routes.adjustTierPoints)
  async adjustTierPoints(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.adjustTierPoints, body, params);
  }

  @Post(':id/birthday')
  @HttpCode(200)
  @HttpContract(routes.correctBirthday)
  async correctBirthday(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.correctBirthday, body, params);
  }

  @Post(':id/status')
  @HttpContract(routes.setStatus)
  async setStatus(@Req() req: AuthenticatedRequest, @Param() params: Record<string, string>, @Body() body: Record<string, unknown>) {
    return this.rest(req, routes.setStatus, body, params);
  }
}
