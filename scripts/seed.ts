import 'reflect-metadata';
import { bootstrapRelease } from '@storeweave/bootstrap-release';
import { release } from '@storeweave/selected-release';
import { seed } from '@storeweave/selected-seed';

async function main() {
  if (seed.releaseId !== release.id) throw new Error('Seed does not match the selected release');
  const demo = process.argv.includes('--demo');
  if (demo && !seed.demo) throw new Error(`Release "${release.id}" has no demo seed`);
  const { runtime } = await bootstrapRelease(release, { loggerName: 'storeweave-seed', logDestination: 'stderr' });
  try {
    const applied = await runtime.migrate();
    if (demo) await seed.demo!(runtime);
    console.log(JSON.stringify({ release: release.id, applied, demo }));
  } finally { await runtime.close(); }
}

main().catch(error => {
  console.error(`Seed failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
