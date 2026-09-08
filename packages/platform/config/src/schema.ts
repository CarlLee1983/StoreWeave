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

const commonConfigSchema = z.object({
  version: z.literal(1),
  store: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    name: z.string().min(1),
    locale: z.string().default('zh-TW'),
    timezone: z.string().default('Asia/Taipei'),
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
  }).default({}),
  shutdown: z.object({ timeoutMs: z.number().int().positive().default(25_000) }).default({}),
  theme: z.object({
    id: z.string().default('default'),
    options: z.record(z.unknown()).default({}),
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
    /** API token 對應到角色；token 值一律來自環境變數，不寫在設定檔。 */
    tokens: z.array(z.object({
      name: z.string().min(1),
      /**
       * 機器對機器的 token 不能扮成顧客或匿名訪客：那兩個角色的資料範圍是由
       * `Actor.type` 決定的，而 token 產生的 actor 一律是 service ——
       * 指成 customer 會得到一個「看得到全部訂單的顧客」。
       */
      role: z.string().min(1),
      /** 讀取 token 值的環境變數名稱。 */
      secretRef: z.string().min(1),
    })).default([]),
    /**
     * Session 存活時間。前台會員與後台操作者分開：購物站被每 12 小時踢出去會很痛，
     * 而後台是操作者帳號，暴露窗口短一點合理。
     */
    sessionTtlMinutes: z.object({
      operator: z.number().int().min(5).max(60 * 24 * 30).default(12 * 60),
      customer: z.number().int().min(5).max(60 * 24 * 365).default(30 * 24 * 60),
    }).default({}),
  }).default({}),
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
});

export const commerceConfigSchema = commonConfigSchema.extend({
  store: commonConfigSchema.shape.store.extend({ currency: z.string().length(3).default('TWD') }),
  auth: commonConfigSchema.shape.auth.removeDefault().extend({
    tokens: z.array(commonConfigSchema.shape.auth.removeDefault().shape.tokens.removeDefault().element.extend({
      role: z.enum(['admin', 'staff', 'readonly', 'mcp']),
    })).default([]),
  }).default({}),
});

export const baseConfigSchema = commonConfigSchema.extend({
  store: commonConfigSchema.shape.store.extend({
    locale: z.string().default('en'), timezone: z.string().default('UTC'),
  }).strict(),
  theme: commonConfigSchema.shape.theme.removeDefault().extend({ id: z.string().default('none') }).default({}),
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
