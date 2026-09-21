import { buildReleaseManifest } from '../packages/platform/release/src/runtime';
import { catalogDigest } from '@storeweave/db';
import { release } from '@storeweave/selected-runtime';

const manifest = buildReleaseManifest(release);
process.stdout.write(JSON.stringify({ manifest, checksum: catalogDigest(manifest) }));
