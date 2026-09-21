import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceRoots = ['apps', 'packages', 'scripts', 'tests', 'tools'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf('.'))) ? [path] : [];
  });
}

describe('retired bundle assembly', () => {
  it('has no package, source imports, or Docker workspace manifest entry', () => {
    expect(existsSync(resolve(root, 'packages/platform/bundle'))).toBe(false);
    const imports: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of sourceFiles(resolve(root, sourceRoot))) {
        const content = readFileSync(file, 'utf8');
        if (/\b(?:from\s*|import\s*\()\s*['"](?:@storeweave\/bundle|[^'"]*\/bundle\/src\/)/.test(content)) {
          imports.push(file.slice(root.length + 1));
        }
      }
    }
    expect(imports).toEqual([]);
    expect(readFileSync(resolve(root, 'Dockerfile'), 'utf8')).not.toContain('packages/platform/bundle');
  });

  it('cannot resolve a synthetic import of the retired package', () => {
    const configPath = resolve(root, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const consumer = resolve(root, 'tests/architecture/__synthetic-legacy-bundle-consumer__.ts');
    const result = ts.resolveModuleName('@storeweave/bundle', consumer, parsed.options, ts.sys);
    expect(result.resolvedModule).toBeUndefined();
  });
});
