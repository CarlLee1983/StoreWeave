import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { catalogDigest } from '@storeweave/db';

/** Structural archive fixture; dummy executables are not production application validation. */
export function writeNativeRelease(directory: string, releaseId = 'commerce', version = '1.0.0') {
  const name = releaseId === 'commerce' ? 'commerce' : 'storeweave';
  const manifest = { schemaVersion: 1, releaseId, releaseVersion: version, baseVersion: '1.0.0' };
  const files = {
    RELEASE: `${releaseId}\n`, VERSION: `${version}\n`,
    'build-info.json': JSON.stringify({ releaseId, version, manifestChecksum: catalogDigest(manifest) }),
    'release-manifest.json': JSON.stringify(manifest),
    'scripts/install.sh': '#!/bin/sh\n', 'scripts/validate-release.js': '// fixture\n',
    [`config/${name}.yaml.example`]: '', [`config/${name}.env.example`]: '',
    [`systemd/${name}-api.service`]: '', [`systemd/${name}-worker.service`]: '',
    ...Object.fromEntries(['api', 'worker', 'cli', 'seed'].map(name => [`app/${name}.js`, '// fixture\n'])),
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), contents);
  }
  for (const file of ['runtime/bin/node', `bin/${name}`]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
}
