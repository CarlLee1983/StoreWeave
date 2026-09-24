import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertReleaseBaseline, projectReleaseBaseline, readExpectedBaseline, type ReleaseBaseline } from './release-baseline';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory() {
  const value = mkdtempSync(join(tmpdir(), 'storeweave-release-baseline-test-'));
  directories.push(value);
  return value;
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe('SW-102 release baseline', () => {
  it('records deterministic Base and Commerce manifests, selections, target import graphs, and public-contract inputs', async () => {
    const actual = await projectReleaseBaseline(directory());
    assertReleaseBaseline(actual, readExpectedBaseline());
  }, 120_000);

  it('is deterministic across independent artifact projections', async () => {
    await expect(projectReleaseBaseline(directory())).resolves.toEqual(await projectReleaseBaseline(directory()));
  }, 120_000);

  it('identifies the affected release and target when a target is absent', async () => {
    const actual = await projectReleaseBaseline(directory());
    const changed = copy(actual);
    changed.releases.commerce.targets.cli = { status: 'absent' };
    expect(() => assertReleaseBaseline(changed, actual)).toThrow('commerce/cli target');
  }, 120_000);

  it('identifies the release when public-contract inputs change', async () => {
    const actual = await projectReleaseBaseline(directory());
    const changed = copy(actual) as ReleaseBaseline;
    if (changed.releases.commerce.publicContract.status !== 'present') throw new Error('Commerce public-contract baseline missing');
    changed.releases.commerce.publicContract.inputs[0]!.sha256 = 'changed';
    expect(() => assertReleaseBaseline(changed, actual)).toThrow('commerce/public-contract');
  }, 120_000);
});
