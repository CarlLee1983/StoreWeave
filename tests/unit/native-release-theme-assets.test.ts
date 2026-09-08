import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Native release staging', () => {
  it('includes the public Default Theme media that the bundled API serves', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/build-release.sh'), 'utf8');

    expect(script).toContain('[ ! -d "$BUILD_DIR/theme-assets" ] || cp -R "$BUILD_DIR/theme-assets" "$STAGE/theme-assets"');
  });
});
