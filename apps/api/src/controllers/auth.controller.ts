import { Body, Controller, HttpCode, Inject, Post, Req, Res, Get } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError } from '@storeweave/contracts';
import { roleFor } from '@storeweave/authorization';
import { ok } from '../http/envelope';
import { Anonymous, Public, type AuthenticatedRequest } from '../http/auth';
import { clearSessionCookies, sessionTokenOf } from '../http/session-cookies';
import { HTTP_ADAPTER, type ReleaseHttpAdapter } from '../release-adapter';
import { RUNTIME, type Runtime } from '../tokens';
import { z } from 'zod';
import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema';
import { HttpContract, type DirectHttpContract } from '../http/contract';
import { SchemaPipe } from '../http/validation';

export const loginInput = z.object({
  email: z.string().min(1), password: z.string().min(1),
  /** 第二因素。角色要求且已註冊時才會被檢查。 */
  mfaCode: z.string().min(1).optional(),
  recoveryCode: z.string().min(1).optional(),
}).strict();
export const changePasswordInput = z.object({
  currentPassword: z.string().min(1), newPassword: z.string().min(1),
}).strict();
export const registerInput = z.object({
  email: z.string().email(), password: z.string().min(1), displayName: z.string().min(1).max(120).optional(),
}).strict();
export const tokenInput = z.object({ token: z.string().min(1) }).strict();
export const forgotPasswordInput = z.object({ email: z.string().min(1) }).strict();
export const resetPasswordInput = z.object({
  token: z.string().min(1), newPassword: z.string().min(1),
}).strict();
export const changeEmailInput = z.object({
  currentPassword: z.string().min(1), newEmail: z.string().email(),
}).strict();
export const mfaCodeInput = z.object({ code: z.string().min(1) }).strict();
export const mfaDisableInput = z.object({
  currentPassword: z.string().min(1), code: z.string().min(1),
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
const accepted = {
  type: 'object', required: ['accepted'], additionalProperties: false,
  properties: { accepted: { type: 'boolean', const: true } },
} as const satisfies JsonSchema7Type;
const recoveryCodes = {
  type: 'object', required: ['recoveryCodes'], additionalProperties: false,
  properties: { recoveryCodes: { type: 'array', items: { type: 'string' } } },
} as const satisfies JsonSchema7Type;
const routes = {
  login: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(loginInput as never, { target: 'jsonSchema7' }), output: response({
    ...user, required: [...user.required, 'cartNotice'],
    properties: {
      ...user.properties, cartNotice: { type: ['string', 'null'] },
      // 只在角色要求第二因素而帳號還沒註冊時出現：UI 據此把人帶去設定流程。
      mfaEnrolmentRequired: { type: 'boolean', const: true },
    },
  }) },
  logout: { kind: 'direct', request: 'none', input: emptyInput, output: response({
    type: 'object', required: ['loggedOut'], additionalProperties: false, properties: { loggedOut: { type: 'boolean', const: true } },
  }) },
  me: { kind: 'direct', request: 'none', auth: 'session', input: emptyInput, output: response(user) },
  changePassword: { kind: 'direct', request: 'body', auth: 'session', input: zodToJsonSchema(changePasswordInput as never, { target: 'jsonSchema7' }), output: response({
    type: 'object', required: ['changed'], additionalProperties: false, properties: { changed: { type: 'boolean', const: true } },
  }) },
  register: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(registerInput as never, { target: 'jsonSchema7' }), output: response(user) },
  // 中性回應：這支端點不告訴呼叫者這個地址存不存在，成功與否都是同一個形狀。
  forgotPassword: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(forgotPasswordInput as never, { target: 'jsonSchema7' }), output: response(accepted) },
  resetPassword: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(resetPasswordInput as never, { target: 'jsonSchema7' }), output: response(accepted) },
  verifyEmail: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(tokenInput as never, { target: 'jsonSchema7' }), output: response(user) },
  resendVerification: { kind: 'direct', request: 'none', auth: 'session', rateLimit: 'auth', input: emptyInput, output: response(accepted) },
  changeEmail: { kind: 'direct', request: 'body', auth: 'session', rateLimit: 'auth', input: zodToJsonSchema(changeEmailInput as never, { target: 'jsonSchema7' }), output: response(accepted) },
  confirmEmailChange: { kind: 'direct', request: 'body', rateLimit: 'auth', input: zodToJsonSchema(tokenInput as never, { target: 'jsonSchema7' }), output: response(user) },
  revokeOtherSessions: { kind: 'direct', request: 'none', auth: 'session', input: emptyInput, output: response(accepted) },
  mfaStatus: { kind: 'direct', request: 'none', auth: 'session', input: emptyInput, output: response({
    type: 'object', required: ['enrolled', 'confirmed', 'recoveryCodesRemaining'], additionalProperties: false,
    properties: { enrolled: { type: 'boolean' }, confirmed: { type: 'boolean' }, recoveryCodesRemaining: { type: 'number' } },
  }) },
  mfaEnroll: { kind: 'direct', request: 'none', auth: 'session', rateLimit: 'auth', input: emptyInput, output: response({
    type: 'object', required: ['secret', 'uri'], additionalProperties: false,
    properties: { secret: { type: 'string' }, uri: { type: 'string' } },
  }) },
  mfaConfirm: { kind: 'direct', request: 'body', auth: 'session', rateLimit: 'auth', input: zodToJsonSchema(mfaCodeInput as never, { target: 'jsonSchema7' }), output: response(recoveryCodes) },
  mfaRecoveryCodes: { kind: 'direct', request: 'body', auth: 'session', rateLimit: 'auth', input: zodToJsonSchema(mfaCodeInput as never, { target: 'jsonSchema7' }), output: response(recoveryCodes) },
  mfaDisable: { kind: 'direct', request: 'body', auth: 'session', rateLimit: 'auth', input: zodToJsonSchema(mfaDisableInput as never, { target: 'jsonSchema7' }), output: response(accepted) },
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
      mfaCode: body.mfaCode,
      recoveryCode: body.recoveryCode,
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
      ...(session.mfaEnrolmentRequired ? { mfaEnrolmentRequired: true } : {}),
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
   * 自助註冊。角色由 release 的目錄決定（`selfServiceRegistration`），不由請求指定——
   * 讓呼叫端選角色等於把權限決策搬到 HTTP 層。
   */
  @Public()
  @Anonymous()
  @Post('register')
  @HttpCode(200)
  @HttpContract(routes.register)
  async register(
    @Body(new SchemaPipe(registerInput)) body: z.infer<typeof registerInput>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const header = req.headers['user-agent'];
    const session = await this.runtime.auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      userAgent: Array.isArray(header) ? header[0] : header,
    });
    await this.http.startSession(this.runtime, req, reply, session);
    return ok({
      id: session.user.id, email: session.user.email,
      displayName: session.user.displayName, role: session.user.role,
    });
  }

  /** 忘記密碼。永遠回同一個形狀，寄信失敗也一樣——差異就是帳號枚舉管道。 */
  @Public()
  @Anonymous()
  @Post('forgot-password')
  @HttpCode(200)
  @HttpContract(routes.forgotPassword)
  async forgotPassword(@Body(new SchemaPipe(forgotPasswordInput)) body: z.infer<typeof forgotPasswordInput>) {
    try {
      await this.runtime.auth.requestPasswordReset({ email: body.email });
    } catch (error) {
      this.runtime.logger.error({ error: (error as Error).message }, 'password reset delivery failed');
    }
    return ok({ accepted: true });
  }

  @Public()
  @Anonymous()
  @Post('reset-password')
  @HttpCode(200)
  @HttpContract(routes.resetPassword)
  async resetPassword(@Body(new SchemaPipe(resetPasswordInput)) body: z.infer<typeof resetPasswordInput>) {
    await this.runtime.auth.resetPassword({ token: body.token, newPassword: body.newPassword });
    return ok({ accepted: true });
  }

  // 連結是從信裡點進來的，當下不一定有 session。證據是簽章，不是 cookie。
  @Public()
  @Anonymous()
  @Post('verify-email')
  @HttpCode(200)
  @HttpContract(routes.verifyEmail)
  async verifyEmail(@Body(new SchemaPipe(tokenInput)) body: z.infer<typeof tokenInput>) {
    const verified = await this.runtime.auth.verifyEmail({ token: body.token });
    return ok({ id: verified.id, email: verified.email, displayName: verified.displayName, role: verified.role });
  }

  @Post('resend-verification')
  @HttpCode(200)
  @HttpContract(routes.resendVerification)
  async resendVerification(@Req() req: AuthenticatedRequest) {
    const { resolved } = await this.sessionOf(req);
    await this.runtime.auth.requestEmailVerification({ userId: resolved.user.id });
    return ok({ accepted: true });
  }

  /** 換信箱要現有密碼，確認信只寄到新地址；舊地址在確認之前一直有效。 */
  @Post('change-email')
  @HttpCode(200)
  @HttpContract(routes.changeEmail)
  async changeEmail(
    @Req() req: AuthenticatedRequest,
    @Body(new SchemaPipe(changeEmailInput)) body: z.infer<typeof changeEmailInput>,
  ) {
    const { resolved } = await this.sessionOf(req);
    await this.runtime.auth.requestEmailChange({
      userId: resolved.user.id, currentPassword: body.currentPassword, newEmail: body.newEmail,
    });
    return ok({ accepted: true });
  }

  @Public()
  @Anonymous()
  @Post('confirm-email-change')
  @HttpCode(200)
  @HttpContract(routes.confirmEmailChange)
  async confirmEmailChange(@Body(new SchemaPipe(tokenInput)) body: z.infer<typeof tokenInput>) {
    const changed = await this.runtime.auth.confirmEmailChange({ token: body.token });
    return ok({ id: changed.id, email: changed.email, displayName: changed.displayName, role: changed.role });
  }

  /** 「登出其他所有裝置」。留下自己這一台，否則按下去的人也被踢出去。 */
  @Post('revoke-other-sessions')
  @HttpCode(200)
  @HttpContract(routes.revokeOtherSessions)
  async revokeOtherSessions(@Req() req: AuthenticatedRequest) {
    const { token, resolved } = await this.sessionOf(req);
    await this.runtime.auth.revokeAllSessions(this.runtime.database.db, resolved.user.id, token);
    return ok({ accepted: true });
  }

  @Get('mfa')
  @HttpContract(routes.mfaStatus)
  async mfaStatus(@Req() req: AuthenticatedRequest) {
    const { resolved } = await this.sessionOf(req);
    return ok(await this.runtime.mfa.statusFor(this.runtime.database.db, resolved.user.id));
  }

  /** 開始註冊。秘密在確認之前不生效，掃描失敗的人不會把自己鎖在外面。 */
  @Post('mfa/enroll')
  @HttpCode(200)
  @HttpContract(routes.mfaEnroll)
  async mfaEnroll(@Req() req: AuthenticatedRequest) {
    const { resolved } = await this.mfaSessionOf(req);
    const enrolment = await this.runtime.database.transaction(tx => this.runtime.mfa.beginEnrolment(tx, {
      userId: resolved.user.id, accountName: resolved.user.email,
    }));
    return ok({ secret: enrolment.secret, uri: enrolment.uri });
  }

  /** 確認註冊，並一次發完復原碼——它們只顯示這一次。 */
  @Post('mfa/confirm')
  @HttpCode(200)
  @HttpContract(routes.mfaConfirm)
  async mfaConfirm(
    @Req() req: AuthenticatedRequest,
    @Body(new SchemaPipe(mfaCodeInput)) body: z.infer<typeof mfaCodeInput>,
  ) {
    const { resolved } = await this.mfaSessionOf(req);
    const codes = await this.runtime.database.transaction(tx => this.runtime.mfa.confirmEnrolment(tx, {
      userId: resolved.user.id, code: body.code,
    }));
    return ok({ recoveryCodes: codes });
  }

  /** 重發復原碼。舊的一批同時作廢：兩批同時有效等於備份的備份沒有人管得動。 */
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @HttpContract(routes.mfaRecoveryCodes)
  async mfaRecoveryCodes(
    @Req() req: AuthenticatedRequest,
    @Body(new SchemaPipe(mfaCodeInput)) body: z.infer<typeof mfaCodeInput>,
  ) {
    const { resolved } = await this.mfaSessionOf(req);
    const passed = await this.runtime.mfa.verifyForLogin(this.runtime.database.db, {
      userId: resolved.user.id, code: body.code,
    });
    if (!passed) throw new PlatformError('UNAUTHENTICATED', 'That code is not valid');
    const codes = await this.runtime.database.transaction(tx => this.runtime.mfa.replaceRecoveryCodes(tx, resolved.user.id));
    return ok({ recoveryCodes: codes });
  }

  /** 關閉第二因素要密碼加一組有效代碼：只有 session 的人關不掉別人的保護。 */
  @Post('mfa/disable')
  @HttpCode(200)
  @HttpContract(routes.mfaDisable)
  async mfaDisable(
    @Req() req: AuthenticatedRequest,
    @Body(new SchemaPipe(mfaDisableInput)) body: z.infer<typeof mfaDisableInput>,
  ) {
    const { token, resolved } = await this.mfaSessionOf(req);
    await this.runtime.auth.assertPassword(resolved.user.id, body.currentPassword);
    const passed = await this.runtime.mfa.verifyForLogin(this.runtime.database.db, {
      userId: resolved.user.id, code: body.code, recoveryCode: body.code.includes('-') ? body.code : undefined,
    });
    if (!passed) throw new PlatformError('UNAUTHENTICATED', 'That code is not valid');
    await this.runtime.database.transaction(tx => this.runtime.mfa.disable(tx, resolved.user.id));
    // 關掉第二因素是安全性下降的動作：其他裝置一律重新登入。
    await this.runtime.auth.revokeAllSessions(this.runtime.database.db, resolved.user.id, token);
    return ok({ accepted: true });
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

  /**
   * 第二因素只存在於宣告 `account.mfa` 的角色上。沒宣告的角色登入時不會驗它，
   * 讓他註冊等於發一個什麼都不擋、卻讓人以為受保護的第二因素——那比沒有更糟。
   */
  private async mfaSessionOf(req: AuthenticatedRequest) {
    const session = await this.sessionOf(req);
    const account = roleFor(this.runtime.roles, session.resolved.user.role)?.account;
    if (!account || !account.mfa) {
      throw PlatformError.validation('This account type does not use a second factor');
    }
    return session;
  }
}
