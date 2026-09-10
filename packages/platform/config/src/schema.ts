import { z } from 'zod';

export const extensionConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

const corsOriginSchema = z.string().url().superRefine((value, context) => {
  const authority = value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (/[\u0000-\u001F\u007F]|\s/.test(value) || value.includes('\\') || /[?#]/.test(value) || authority.endsWith(':') || !/^https?:\/\/[^/]+\/?$/i.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CORS origins must be an HTTP(S) origin without whitespace, backslashes, paths, queries, or fragments' });
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CORS origins must be valid URLs' });
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol) || value.includes('@') || url.username || url.password || url.hostname.includes('*') || url.pathname !== '/') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CORS origins must be an HTTP(S) origin without credentials or a path' });
  }
}).transform(value => {
  try { return new URL(value).origin; }
  catch { return value; }
});

const corsConfigSchema = z.object({
  allowedOrigins: z.array(corsOriginSchema).default([]),
  credentials: z.boolean().default(false),
}).superRefine((cors, context) => {
  if (new Set(cors.allowedOrigins).size !== cors.allowedOrigins.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedOrigins'], message: 'CORS origins must not contain normalized duplicates' });
  }
  if (cors.credentials && cors.allowedOrigins.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['credentials'], message: 'CORS credentials require at least one allowed origin' });
  }
});

/**
 * 簽章金鑰。key id 會直接出現在已簽發的值裡（短效下載連結、密碼重設連結），
 * 所以字集必須能安全通過 URL 與 token 的分隔符號，而且發行後不能改指到別的秘密。
 * 秘密本身一律走 secretRef，設定檔裡永遠只有名稱。
 */
const signingKeyConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  secretRef: z.string().min(1),
}).strict();

const securityConfigSchema = z.object({
  signingKeys: z.array(signingKeyConfigSchema).default([]),
  /** 新值用哪一把簽。只有一把時可省略；多把時必須明說，避免輪替期間簽錯。 */
  activeSigningKeyId: z.string().optional(),
}).superRefine((security, context) => {
  const ids = security.signingKeys.map((key) => key.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['signingKeys'], message: 'Signing key ids must be unique' });
  }
  if (security.activeSigningKeyId === undefined) {
    if (ids.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom, path: ['activeSigningKeyId'],
        message: 'activeSigningKeyId is required once more than one signing key is configured',
      });
    }
    return;
  }
  if (!ids.includes(security.activeSigningKeyId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['activeSigningKeyId'],
      message: 'activeSigningKeyId must name a configured signing key',
    });
  }
}).transform((security) => ({
  signingKeys: security.signingKeys,
  ...(security.activeSigningKeyId ?? security.signingKeys[0]?.id
    ? { activeSigningKeyId: security.activeSigningKeyId ?? security.signingKeys[0].id }
    : {}),
}));

/**
 * 時區名稱要真的能用。打錯一個字會讓 `Intl.DateTimeFormat` 丟 RangeError，而顯示層
 * 的回退是輸出 UTC ISO——結果是全站每個日期悄悄變成另一種寫法，沒有任何 log。
 * 寧可在啟動時就掛掉。
 *
 * 條件就是「ICU 認得」，所以除了 IANA 名稱，`UTC` 與 `+08:00` 這類固定位移也會
 * 通過。固定位移沒有日光節約，跨時區營運請寫 IANA 名稱。前後空白一律拒絕，
 * 不默默修剪。
 */
const timeZoneSchema = z.string().refine((timeZone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}, { message: 'Must be a time zone ICU recognises, for example Asia/Taipei' });

const commonConfigSchema = z.object({
  version: z.literal(1),
  store: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    name: z.string().min(1),
    locale: z.string().default('zh-TW'),
    timezone: timeZoneSchema.default('Asia/Taipei'),
    supportEmail: z.string().email().optional(),
  }),
  http: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    publicUrl: z.string().url().default('http://localhost:3000'),
    cors: corsConfigSchema.default({}),
    trustProxy: z.boolean().default(false),
    bodyLimitBytes: z.coerce.number().int().positive().default(1_048_576),
  }).default({}),
  database: z.object({
    url: z.string().min(1),
    poolSize: z.coerce.number().int().min(1).max(100).default(10),
    ssl: z.boolean().default(false),
    autoMigrate: z.boolean().default(false),
  }),
  worker: z.object({
    enabled: z.boolean().default(true),
    concurrency: z.coerce.number().int().min(1).max(64).default(4),
    pollIntervalMs: z.coerce.number().int().min(50).default(1000),
    outboxBatchSize: z.coerce.number().int().min(1).max(1000).default(100),
    staleLockSeconds: z.coerce.number().int().min(10).default(300),
    completedPayloadRetentionDays: z.coerce.number().int().positive().default(7),
    cancelledPayloadRetentionDays: z.coerce.number().int().positive().default(7),
    dedupeHorizonDays: z.coerce.number().int().positive().default(30),
    retentionCleanupBatchSize: z.coerce.number().int().min(1).max(1000).default(100),
  }).superRefine((value, context) => {
    const minimum = Math.max(value.completedPayloadRetentionDays, value.cancelledPayloadRetentionDays);
    if (value.dedupeHorizonDays < minimum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dedupeHorizonDays'],
        message: 'dedupeHorizonDays must be at least each terminal payload retention period',
      });
    }
  }).default({}),
  cache: z.object({
    /** A single cleanup call is bounded so a cache sweep cannot monopolize the DB. */
    cleanupBatchSize: z.coerce.number().int().min(1).max(10_000).default(500),
    /** Runs only after release activation; its timer is unref'd and never blocks shutdown. */
    cleanupIntervalMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    /** Advisory-lock contention is polled rather than consuming a blocked DB session. */
    lockRetryIntervalMs: z.coerce.number().int().min(1).max(10_000).default(25),
    /** Held advisory locks use a separate pool, avoiding self-starvation of domain transactions. */
    mutexPoolSize: z.coerce.number().int().min(1).max(20).default(2),
    /** Bounds half-open mutex-pool connections; runtime also caps this below shutdown budget. */
    mutexConnectionTimeoutMs: z.coerce.number().int().min(1).max(60_000).default(5_000),
  }).default({}),
  storage: z.object({
    /** Both adapters are private; HTTP policy decides whether an object is publicly readable. */
    driver: z.enum(['local', 's3']).default('local'),
    /** Defaults at runtime to `<paths.dataDir>/storage`, outside release-owned artifacts. */
    localRoot: z.string().min(1).optional(),
    maxUploadBytes: z.coerce.number().int().min(1).max(1024 * 1024 * 1024).default(20 * 1024 * 1024),
    signedUrlTtlSeconds: z.coerce.number().int().min(1).max(60 * 60).default(300),
    cleanupIntervalMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
    staleObjectSeconds: z.coerce.number().int().min(60).max(7 * 24 * 60 * 60).default(60 * 60),
    s3: z.object({
      bucket: z.string().min(3).max(255),
      region: z.string().min(1).default('us-east-1'),
      endpoint: z.string().url().optional(),
      forcePathStyle: z.boolean().default(false),
      prefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).optional(),
      accessKeyIdRef: z.string().min(1),
      secretAccessKeyRef: z.string().min(1),
    }).strict().optional(),
  }).superRefine((storage, context) => {
    if (storage.driver === 's3' && !storage.s3) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['s3'], message: 's3 configuration is required when storage.driver is s3' });
    }
  }).default({}),
  /**
   * Mail is deliberately disabled until an SMTP transport is explicitly
   * configured.  A production release must never turn an SMTP outage into a
   * successful-looking mock delivery.
   */
  mail: z.object({
    transport: z.enum(['disabled', 'smtp']).default('disabled'),
    from: z.string().email().optional(),
    smtp: z.object({
      host: z.string().min(1),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      usernameRef: z.string().min(1).optional(),
      passwordRef: z.string().min(1).optional(),
      // Mail jobs are leased for 60 seconds. Keep SMTP I/O below that lease so
      // a timed-out worker cannot leave a later worker racing the same send.
      connectionTimeoutMs: z.coerce.number().int().min(100).max(55_000).default(10_000),
      socketTimeoutMs: z.coerce.number().int().min(100).max(55_000).default(30_000),
    }).strict().optional(),
  }).superRefine((mail, context) => {
    if (mail.transport !== 'smtp') return;
    if (!mail.from) context.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'mail.from is required when mail.transport is smtp' });
    if (!mail.smtp) context.addIssue({ code: z.ZodIssueCode.custom, path: ['smtp'], message: 'mail.smtp is required when mail.transport is smtp' });
    if (mail.smtp && Boolean(mail.smtp.usernameRef) !== Boolean(mail.smtp.passwordRef)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['smtp'], message: 'SMTP usernameRef and passwordRef must be configured together' });
    }
  }).default({}),
  shutdown: z.object({ timeoutMs: z.number().int().positive().default(25_000) }).default({}),
  theme: z.object({
    id: z.string().default('default'),
    /**
     * 視覺設定依 theme id 分開保存（ADR 0045）：換過去再換回來，原本的配色與設定還在。
     * 舊的扁平寫法會在這裡被擋下來，不會被當成某個 theme 的設定安靜吃掉。
     */
    options: z.record(z.record(z.unknown())).default({}),
  }).default({}),
  admin: z.object({
    enabled: z.boolean().default(true),
    basePath: z.string().startsWith('/').default('/admin'),
  }).default({}),
  mcp: z.object({
    enabled: z.boolean().default(true),
    path: z.string().startsWith('/').default('/mcp'),
  }).default({}),
  auth: z.object({
    /**
     * Session 存活時間。前台會員與後台操作者分開：購物站被每 12 小時踢出去會很痛，
     * 而後台是操作者帳號，暴露窗口短一點合理。
     *
     * 機器對機器的 token 不在設定檔裡：它們存在資料庫，由 CLI 簽發，可到期可撤銷（ADR 0043）。
     */
    sessionTtlMinutes: z.object({
      operator: z.number().int().min(5).max(60 * 24 * 30).default(12 * 60),
      customer: z.number().int().min(5).max(60 * 24 * 365).default(30 * 24 * 60),
    }).default({}),
    // strict：升級時帶著舊的 `auth.tokens` 會直接失敗，而不是安靜地被忽略——
    // 安靜忽略等於讓一批以為還有效的 token 在下次部署後突然全部失效（ADR 0043）。
  }).strict().default({}),
  extensions: z.array(extensionConfigSchema).default([]),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    /** `stdout` 交給 journald；`file` 寫入 /var/log/commerce。 */
    destination: z.enum(['stdout', 'file']).default('stdout'),
    file: z.string().default('/var/log/commerce/commerce.log'),
  }).default({}),
  paths: z.object({
    dataDir: z.string().default('/var/lib/commerce'),
    backupDir: z.string().default('/var/lib/commerce/backups'),
  }).default({}),
  secrets: z.object({
    /** `env` 直接讀環境變數；`file` 先載入 dotenv 風格檔案再讀環境變數。 */
    provider: z.enum(['env', 'file']).default('env'),
    file: z.string().default('/etc/commerce/commerce.env'),
  }).default({}),
  security: securityConfigSchema.default({}),
});

export const commerceConfigSchema = commonConfigSchema.extend({
  store: commonConfigSchema.shape.store.extend({ currency: z.string().length(3).default('TWD') }),
});

export const baseConfigSchema = commonConfigSchema.extend({
  store: commonConfigSchema.shape.store.extend({
    locale: z.string().default('en'), timezone: timeZoneSchema.default('UTC'),
  }).strict(),
  // base release 有自己的通用 theme；沒有商務模組不代表沒有網站（ADR 0046）。
  theme: commonConfigSchema.shape.theme.removeDefault().extend({ id: z.string().default('base') }).default({}),
  admin: commonConfigSchema.shape.admin.removeDefault().extend({ enabled: z.boolean().default(false) }).default({}),
  mcp: commonConfigSchema.shape.mcp.removeDefault().extend({ enabled: z.boolean().default(false) }).default({}),
  logging: commonConfigSchema.shape.logging.removeDefault().extend({
    file: z.string().default('/var/log/storeweave/storeweave.log'),
  }).default({}),
  paths: z.object({
    dataDir: z.string().default('/var/lib/storeweave'),
    backupDir: z.string().default('/var/lib/storeweave/backups'),
  }).default({}),
  secrets: commonConfigSchema.shape.secrets.removeDefault().extend({
    file: z.string().default('/etc/storeweave/storeweave.env'),
  }).default({}),
}).strict();

export type BaseConfig = z.infer<typeof baseConfigSchema>;

export type CommerceConfig = z.infer<typeof commerceConfigSchema>;
export type ExtensionConfigEntry = z.infer<typeof extensionConfigSchema>;
