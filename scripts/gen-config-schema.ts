// 從 Zod schema 產生 commerce.yaml 的 JSON Schema，供編輯器與 CI 驗證使用。
// 執行：npx tsx scripts/gen-config-schema.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { baseConfigSchema, commerceConfigSchema } from '@storeweave/config';

const root = join(__dirname, '..');
for (const [file, name, configSchema, title] of [
  ['commerce.schema.json', 'CommerceConfig', commerceConfigSchema, 'StoreWeave commerce.yaml'],
  ['base.schema.json', 'BaseConfig', baseConfigSchema, 'StoreWeave storeweave.yaml'],
] as const) {
  const schema = zodToJsonSchema(configSchema, {
    name, target: 'jsonSchema7', $refStrategy: 'none',
  }) as Record<string, unknown>;
  schema.$schema = 'http://json-schema.org/draft-07/schema#';
  schema.title = title;
  schema.description = 'Release 設定檔結構。機密使用 ${ENV_VAR} 參照。';
  const out = join(root, 'deployments', file);
  writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  console.log(`wrote ${out}`);
}
