import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const releaseIdentitySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const safeReleaseNameSchema = releaseIdentitySchema;
const layoutSchema = z.object({
  schemaVersion: z.literal(1), releaseId: releaseIdentitySchema, name: safeReleaseNameSchema,
  assets: z.object({ admin: z.boolean(), themeAssets: z.boolean() }).strict(),
}).strict();

/** Frozen pre-layout formats only. New products must declare their native layout. */
const historicalLayouts = new Map([
  ['base', { name: 'storeweave', forbidAssets: true }],
  ['commerce', { name: 'commerce', forbidAssets: false }],
]);

export function readNativeLayout(root: string, releaseId: string) {
  const path = join(root, 'native-layout.json');
  const info = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8'));
  const marked = Object.hasOwn(info, 'nativeLayoutVersion');
  if (marked && info.nativeLayoutVersion !== 1) throw new Error('Unsupported native layout version');
  if (marked && !existsSync(path)) throw new Error('Native layout descriptor is missing');
  if (existsSync(path)) {
    if (!marked) throw new Error('Native layout build marker is missing');
    const layout = layoutSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (layout.releaseId !== releaseId) throw new Error('Native layout release identity mismatch');
    for (const [directory, required] of [['admin', layout.assets.admin], ['theme-assets', layout.assets.themeAssets]] as const) {
      if (existsSync(join(root, directory)) !== required) throw new Error(`Native layout asset mismatch: ${directory}`);
      if (required && !lstatSync(join(root, directory)).isDirectory()) throw new Error(`Native layout asset is not a directory: ${directory}`);
    }
    return { name: layout.name, requiredAssets: [
      ...(layout.assets.admin ? ['admin/index.html'] : []),
    ] };
  }
  const historical = historicalLayouts.get(releaseId);
  if (!historical) throw new Error('Native layout metadata is required for this release');
  if (historical.forbidAssets && ['admin', 'theme-assets'].some(path => existsSync(join(root, path)))) {
    throw new Error('Historical Base release contains Commerce assets');
  }
  return { name: historical.name, requiredAssets: [] as string[] };
}
