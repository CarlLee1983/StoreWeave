import { buildReleaseManifest } from '../packages/platform/bundle/src/release-manifest';
import { catalogDigest } from '@storeweave/db';
import { release } from '@storeweave/selected-release';

const manifest = buildReleaseManifest(release);
process.stdout.write(JSON.stringify({ manifest, checksum: catalogDigest(manifest) }));
