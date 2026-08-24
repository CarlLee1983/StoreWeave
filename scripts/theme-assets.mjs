#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_DEFAULT_THEME_ASSETS = [
  {
    relativePath: 'fonts/NotoSansTC-Variable.woff2',
    sha256: '37558262fe31587616f0ef047226e6fe86e1d09dfd550acb811f51f92d8974c6',
  },
  {
    relativePath: 'fonts/NotoSerifTC-Variable.woff2',
    sha256: 'b56adfc86643cdd2fb9dc54563f5d655837e7e12deaa47e8c2e2e94ef5fdc836',
  },
  {
    relativePath: 'fonts/NotoSansTC-OFL.txt',
    sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
  },
  {
    relativePath: 'fonts/NotoSerifTC-OFL.txt',
    sha256: '5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6',
  },
];

/** Default Theme 是正式 Storefront 的一部分，因此 release 不可少掉字型或授權檔。 */
export function assertDefaultThemeAssets(themeAssetsDir) {
  for (const { relativePath, sha256 } of REQUIRED_DEFAULT_THEME_ASSETS) {
    const file = join(themeAssetsDir, relativePath);
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) {
      throw new Error(`missing required Default Theme asset: ${file}`);
    }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== sha256) throw new Error(`Default Theme asset sha256 mismatch: ${file}`);
  }
}

export function copyDefaultThemeAssets(sourceRoot, outputRoot) {
  const source = join(sourceRoot, 'packages/themes/default/assets');
  const destination = join(outputRoot, 'theme-assets/default');
  if (!existsSync(source)) throw new Error(`Default Theme assets not found: ${source}`);

  cpSync(source, destination, { recursive: true });
  assertDefaultThemeAssets(destination);
  return destination;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runCli() {
  const command = process.argv[2];
  if (command === 'copy') {
    const sourceRoot = option('--source');
    const outputRoot = option('--output');
    if (!sourceRoot || !outputRoot) throw new Error('usage: theme-assets.mjs copy --source <root> --output <dist>');
    const destination = copyDefaultThemeAssets(resolve(sourceRoot), resolve(outputRoot));
    console.log(`verified Default Theme assets: ${destination}`);
    return;
  }
  if (command === 'verify') {
    const assetsDir = option('--assets');
    if (!assetsDir) throw new Error('usage: theme-assets.mjs verify --assets <theme-assets/default>');
    assertDefaultThemeAssets(resolve(assetsDir));
    console.log(`verified Default Theme assets: ${resolve(assetsDir)}`);
    return;
  }
  if (command === 'list') {
    for (const { relativePath } of REQUIRED_DEFAULT_THEME_ASSETS) console.log(relativePath);
    return;
  }
  throw new Error('usage: theme-assets.mjs <copy|verify|list> ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error((error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
