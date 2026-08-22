import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusController } from './base';
import { ok } from '../http/envelope';
import { Anonymous, Public, type AuthenticatedRequest } from '../http/auth';
import { setSessionCookies } from '../http/session-cookies';
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
    setSessionCookies(reply, {
      publicUrl: this.runtime.config.http.publicUrl,
      token: session.token,
      expiresAt: session.expiresAt,
    });

    return ok({
      id: registered.customer.id,
      email: registered.email,
      displayName: registered.customer.displayName,
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
}
