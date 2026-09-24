import { releases } from './releases.mjs';

const releaseId = process.argv[2];
const release = releaseId && releases[releaseId];
if (!release) throw new Error(`Unknown release: ${releaseId ?? '<missing>'}`);
if (!release.native) throw new Error(`Release "${releaseId}" has no native packaging plan`);

const plan = release.native;
const values = [plan.name, plan.smokeScript, plan.apiService, plan.workerService, String(plan.configFiles.length)];
for (const file of plan.configFiles) values.push(file.source, file.filename);
process.stdout.write(`${values.join('\n')}\n`);
