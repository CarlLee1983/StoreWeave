import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { GenericContainer } from 'testcontainers';
import { expect, it } from 'vitest';
import { writeNativeRelease } from '../unit/fixtures/native-release';

it('GNU tar root extraction normalizes metadata and rejects sparse bombs before extraction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-root-archive-'));
  try {
    const source = join(directory, 'commerce-1.0.0');
    writeNativeRelease(source);
    const archive = join(directory, 'release.tar.gz');
    execFileSync('python3', ['-c', `
import io,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz', format=tarfile.PAX_FORMAT) as archive:
 archive.add(sys.argv[2], arcname='commerce-1.0.0')
 entry=tarfile.TarInfo('commerce-1.0.0/metadata-probe')
 entry.uid=33333; entry.gid=44444; entry.mode=0o777; entry.size=4
 entry.pax_headers={'SCHILY.xattr.user.storeweave-test':'archive-metadata','SCHILY.acl.access':'user::rwx,group::rwx,other::rwx'}
 archive.addfile(entry,io.BytesIO(b'test'))
`, archive, source]);
    const validator = join(directory, 'validator.cjs');
    await build({ entryPoints: ['tools/cli/src/release-validation.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: validator });
    const container = await new GenericContainer('node:22')
      .withCopyFilesToContainer([{ source: archive, target: '/work/release.tar.gz' }, { source: validator, target: '/work/validator.cjs' }])
      .withCommand(['sleep', 'infinity']).start();
    try {
      const result = await container.exec(['node', '-e', `
        (async () => {
          process.umask(0o022);
          const fs = require('node:fs');
          const release = await require('/work/validator.cjs').installReleaseArchive('/work/release.tar.gz', '/work/releases', 'commerce');
          const stat = fs.statSync(release.directory + '/metadata-probe');
          console.log(JSON.stringify({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `]);
      expect(result.exitCode, result.output).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ uid: 0, gid: 0, mode: 0o755 });
      const attributes = await container.exec(['python3', '-c', "import json,os; print(json.dumps(os.listxattr('/work/releases/1.0.0/metadata-probe')))"]);
      expect(attributes.exitCode, attributes.output).toBe(0);
      expect(JSON.parse(attributes.stdout)).toEqual([]);
      const sparse = await container.exec(['sh', '-c', 'truncate -s 1073741825 /work/sparse && tar --sparse -czf /work/sparse.tar.gz -C /work sparse']);
      expect(sparse.exitCode, sparse.output).toBe(0);
      const rejected = await container.exec(['node', '-e', `
        (async () => {
          const fs = require('node:fs');
          try {
            await require('/work/validator.cjs').installReleaseArchive('/work/sparse.tar.gz', '/work/releases', 'commerce');
            throw new Error('Sparse bomb accepted');
          } catch (error) {
            if (!error.message.includes('expanded payload exceeds')) throw error;
          }
          console.log(JSON.stringify(fs.readdirSync('/work/releases')));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `]);
      expect(rejected.exitCode, rejected.output).toBe(0);
      expect(JSON.parse(rejected.stdout)).toEqual(['1.0.0']);
    } finally { await container.stop(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
