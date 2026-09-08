import { Body, Controller, HttpCode, Inject, Post, Req, Res, Get } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { ok } from '../http/envelope';
import { Anonymous, Public, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, sessionTokenOf } from '../http/session-cookies';
import { HTTP_ADAPTER, type ReleaseHttpAdapter } from '../release-adapter';
import { RUNTIME, type Runtime } from '../tokens';
import { z } from 'zod';
import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { SchemaPipe } from '../http/validation';

export const loginInput = z.object({ email: z.string().min(1), password: z.string().min(1) }).strict();
export const changePasswordInput = z.object({
  currentPassword: z.string().min(1), newPassword: z.string().min(1),
}).strict();

const emptyInput = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema7Type;
const response = (data: JsonSchema7Type) => ({
  type: 'object', required: ['success', 'data'], additionalProperties: false,
  properties: { success: { type: 'boolean', const: true }, data },
} satisfies JsonSchema7Type);
const user = {
  type: 'object', required: ['id', 'email', 'displayName', 'role'], additionalProperties: false,
  properties: { id: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' }, role: { type: 'string' } },
} as const satisfies JsonSchema7Type;
const routes = {
  login: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(loginInput as never, { target: 'jsonSchema7' }), output: response({
    ...user, required: [...user.required, 'cartNotice'], properties: { ...user.properties, cartNotice: { type: ['string', 'null'] } },
  }) },
  logout: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['loggedOut'], additionalProperties: false, properties: { loggedOut: { type: 'boolean', const: true } },
  }) },
  me: { kind: 'direct', request: 'none', auth: 'session', input: emptyInput, output: response(user) },
  changePassword: { kind: 'direct', request: 'body', auth: 'session', input: zodToJsonSchema(changePasswordInput as never, { target: 'jsonSchema7' }), output: response({
    type: 'object', required: ['changed'], additionalProperties: false, properties: { changed: { type: 'boolean', const: true } },
  }) },
} as const satisfies Record<string, DirectHttpContract>;

/** 後台登入。認證發生在 Actor 存在之前，因此不經過 Command/Query Bus，直接呼叫 AuthService。 */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(RUNTIME) private readonly runtime: Runtime,
    @Inject(HTTP_ADAPTER) private readonly http: ReleaseHttpAdapter,
  ) {}

  // 登入時身分還不存在；帶著舊 session 呼叫也只是重新簽發，不該解析出舊身分。
  @Public()
  @Anonymous()
  @Post('login')
  @HttpCode(200)
  @HttpContract(routes.login)
  async login(
    @Body(new SchemaPipe(loginInput)) body: z.infer<typeof loginInput>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const userAgentHeader = req.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

    const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
      email: body.email,
      password: body.password,
      userAgent,
    });

    // 顧客也走這支登入：session 一發出去，訪客車就併進他的車（工單 27）。
    const cartNotice = await this.http.startSession(this.runtime, req, reply, session);

    return ok({
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      role: session.user.role,
      cartNotice,
    });
  }

  // 公開端點：session 已過期時也要能清掉 cookie，否則使用者會卡在壞掉的狀態。
  @Public()
  @Post('logout')
  @HttpCode(200)
  @HttpContract(routes.logout)
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = sessionTokenOf(req, this.runtime.config.http.publicUrl);
    if (token) await this.runtime.auth.revokeSession(this.runtime.database.db, token);
    clearSessionCookies(reply, this.runtime.config.http.publicUrl);
    return ok({ loggedOut: true });
  }

  @Get('me')
  @HttpContract(routes.me)
  async me(@Req() req: AuthenticatedRequest) {
    const { resolved } = await this.sessionOf(req);

    return ok({
      id: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.displayName,
      role: resolved.user.role,
    });
  }


  /** 主動改密碼。走 cookie，因此受 CSRF 保護；改完踢掉其他裝置，留下自己這一台。 */
  @Post('change-password')
  @HttpCode(200)
  @HttpContract(routes.changePassword)
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body(new SchemaPipe(changePasswordInput)) body: z.infer<typeof changePasswordInput>,
  ) {
    const { token, resolved } = await this.sessionOf(req);

    await this.runtime.auth.changePassword(this.runtime.database.db, {
      userId: resolved.user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepToken: token,
    });
    return ok({ changed: true });
  }

  /**
   * 取出這次請求的 session，解析不出來就拒絕。
   *
   * 三支端點原本各寫一次「取 cookie → resolveSession → 401」；同一個判斷分三份，
   * 遲早會有一份的訊息或條件走鐘。
   */
  private async sessionOf(req: AuthenticatedRequest) {
    const token = sessionTokenOf(req, this.runtime.config.http.publicUrl);
    if (!token) throw new PlatformError('UNAUTHENTICATED', 'No active session');
    const resolved = await this.runtime.auth.resolveSession(this.runtime.database.db, token);
    if (!resolved) throw new PlatformError('UNAUTHENTICATED', 'Invalid or expired session');
    return { token, resolved };
  }
}
