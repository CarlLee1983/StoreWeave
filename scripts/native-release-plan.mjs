import { releases } from './releases.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const releaseId = process.argv[2];
const release = releaseId && releases[releaseId];
if (!release) throw new Error(`Unknown release: ${releaseId ?? '<missing>'}`);
if (!release.native) throw new Error(`Release "${releaseId}" has no native packaging plan`);

const plan = release.native;
if (process.argv[3] === '--write-layout') {
  const directory = process.argv[4];
  const infoPath = join(directory, 'build-info.json');
  const build = JSON.parse(readFileSync(infoPath, 'utf8'));
  if (build.releaseId !== releaseId) throw new Error('Native packaging build identity mismatch');
  // Mark the stage first so an interrupted write cannot be read as a historical archive.
  writeFileSync(infoPath, `${JSON.stringify({ ...build, nativeLayoutVersion: 1 }, null, 2)}\n`);
  writeFileSync(join(directory, 'native-layout.json'), `${JSON.stringify({
    schemaVersion: 1, releaseId, name: plan.name,
    assets: { admin: release.admin && process.env.SKIP_ADMIN !== 'true', themeAssets: Boolean(build.storefront?.themeAssets) },
  })}\n`, { flag: 'wx' });
  process.exit(0);
}
const values = [plan.name, plan.smokeScript, plan.apiService, plan.workerService, String(plan.configFiles.length)];
for (const file of plan.configFiles) values.push(file.source, file.filename);
process.stdout.write(`${values.join('\n')}\n`);
