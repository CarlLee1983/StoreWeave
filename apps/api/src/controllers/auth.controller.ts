import { Body, Controller, HttpCode, Inject, Post, Req, Res, Get } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { ok } from '../http/envelope';
import { Anonymous, Public, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, sessionTokenOf } from '../http/session-cookies';
import { startSession } from '../http/session-start';
import { RUNTIME, type Runtime } from '../tokens';

interface LoginBody {
  email?: string;
  password?: string;
}

/** 後台登入。認證發生在 Actor 存在之前，因此不經過 Command/Query Bus，直接呼叫 AuthService。 */
@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  // 登入時身分還不存在；帶著舊 session 呼叫也只是重新簽發，不該解析出舊身分。
  @Public()
  @Anonymous()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!body?.email || !body?.password) {
      throw new PlatformError('VALIDATION_ERROR', 'email 與 password 為必填');
    }

    const userAgentHeader = req.headers['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

    const session = await this.runtime.auth.authenticate(this.runtime.database.db, {
      email: body.email,
      password: body.password,
      userAgent,
    });

    // 顧客也走這支登入：session 一發出去，訪客車就併進他的車（工單 27）。
    const cartNotice = await startSession(this.runtime, req, reply, session);

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
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = sessionTokenOf(req, this.runtime.config.http.publicUrl);
    if (token) await this.runtime.auth.revokeSession(this.runtime.database.db, token);
    clearSessionCookies(reply, this.runtime.config.http.publicUrl);
    return ok({ loggedOut: true });
  }

  @Get('me')
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
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    const { token, resolved } = await this.sessionOf(req);

    if (!body?.currentPassword || !body?.newPassword) {
      throw new PlatformError('VALIDATION_ERROR', 'currentPassword 與 newPassword 為必填');
    }

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
