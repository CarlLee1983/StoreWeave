// 從 Zod schema 產生 commerce.yaml 的 JSON Schema，供編輯器與 CI 驗證使用。
// 執行：npx tsx scripts/gen-config-schema.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { commerceConfigSchema } from '@storeweave/config';

const root = join(__dirname, '..');
const schema = zodToJsonSchema(commerceConfigSchema, {
  name: 'CommerceConfig',
  target: 'jsonSchema7',
  $refStrategy: 'none',
}) as Record<string, unknown>;

schema.$schema = 'http://json-schema.org/draft-07/schema#';
schema.title = 'StoreWeave commerce.yaml';
schema.description = '單站電商平台的設定檔結構。機密不放在這裡，一律用 ${ENV_VAR} 參照。';

const out = join(root, 'deployments/commerce.schema.json');
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}`);
