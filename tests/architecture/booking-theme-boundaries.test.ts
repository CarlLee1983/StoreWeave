import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('Booking Theme package boundary', () => {
  it('resolves the package alias through the root TypeScript configuration', () => {
    const root = process.cwd();
    const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const consumer = resolve(root, 'packages/releases/booking/src/storefront.ts');
    const result = ts.resolveModuleName('@storeweave/theme-booking-default', consumer, parsed.options, ts.sys);

    expect(result.resolvedModule?.resolvedFileName)
      .toBe(resolve(root, 'packages/themes/booking-default/src/index.ts'));
  });
});
