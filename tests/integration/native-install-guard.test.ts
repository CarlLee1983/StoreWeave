import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { GenericContainer } from 'testcontainers';
import { expect, it } from 'vitest';
import { writeNativeRelease } from '../unit/fixtures/native-release';

it('native installer installs fresh and refuses every existing current entry before changing installation state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-install-guard-'));
  try {
    // Structural application fixture; the actual installer and bundled validator run as root in an owned container.
    writeNativeRelease(directory);
    copyFileSync('scripts/install-native.sh', join(directory, 'scripts', 'install.sh'));
    await build({ entryPoints: ['scripts/validate-release.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      outfile: join(directory, 'scripts', 'validate-release.js') });
    await build({ entryPoints: ['tools/cli/src/transition-lock.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      outfile: join(directory, 'scripts', 'transition-lock.cjs') });
    await build({ entryPoints: ['tools/cli/src/pg-tool.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      outfile: join(directory, 'scripts', 'pg-tool.cjs') });
    const container = await new GenericContainer('node:22').withCopyDirectoriesToContainer([{ source: directory, target: '/media' }])
      .withCommand(['sleep', 'infinity']).start();
    try {
      const prepared = await container.exec(['sh', '-c', 'cp /usr/local/bin/node /media/runtime/bin/node']);
      expect(prepared.exitCode, prepared.output).toBe(0);
      const locked = await container.exec(['node', '-e', `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { execFileSync } = require('node:child_process');
        const { withTransitionLock } = require('/media/scripts/transition-lock.cjs');
        (async () => {
          await assert.rejects(withTransitionLock('/opt/commerce', async directory => {
            assert.equal(directory, '/opt/commerce/.transitions');
            assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
            assert.equal(fs.statSync(directory).uid, process.geteuid());
            await assert.rejects(withTransitionLock('/opt/commerce', async () => { throw Error('entered concurrent callback'); }), /Another installation/);
            try { execFileSync('bash', ['/media/scripts/install.sh'], { stdio: 'pipe' }); throw Error('installer ignored lock'); }
            catch (error) { assert.match(String(error.stderr), /Another installation/); }
            assert.equal(fs.existsSync('/opt/commerce/current'), false);
            throw Error('fixture callback failure');
          }), /fixture callback failure/);
          assert.equal(fs.statSync('/opt/commerce/.transition.lock').size, 0);
          fs.chmodSync('/opt/commerce', 0o777);
          await assert.rejects(withTransitionLock('/opt/commerce', async () => { throw Error('entered insecure home'); }), /Installation home/);
          assert.throws(() => execFileSync('bash', ['/media/scripts/install.sh'], { stdio: 'pipe' }), /Unsafe installation home/);
          fs.chmodSync('/opt/commerce', 0o755);
          fs.symlinkSync('/opt/commerce', '/opt/linked-home');
          await assert.rejects(withTransitionLock('/opt/linked-home', async () => { throw Error('followed home symlink'); }), /Installation home/);
          fs.renameSync('/opt/commerce', '/opt/preserved-home');
          fs.symlinkSync('/opt/preserved-home', '/opt/commerce');
          assert.throws(() => execFileSync('bash', ['/media/scripts/install.sh'], { stdio: 'pipe' }), /Unsafe installation home/);
          fs.unlinkSync('/opt/commerce');
          fs.renameSync('/opt/preserved-home', '/opt/commerce');

          fs.chmodSync('/opt/commerce/.transitions', 0o755);
          await assert.rejects(withTransitionLock('/opt/commerce', async () => { throw Error('entered insecure root'); }), /owned 0700/);
          fs.chmodSync('/opt/commerce/.transitions', 0o700);
          fs.renameSync('/opt/commerce/.transitions', '/opt/commerce/preserved-transitions');
          fs.symlinkSync('/opt/commerce/preserved-transitions', '/opt/commerce/.transitions');
          await assert.rejects(withTransitionLock('/opt/commerce', async () => { throw Error('followed root symlink'); }), /owned 0700/);
          fs.unlinkSync('/opt/commerce/.transitions');
          fs.renameSync('/opt/commerce/preserved-transitions', '/opt/commerce/.transitions');
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `]);
      expect(locked.exitCode, locked.output).toBe(0);
      const crashed = await container.exec(['node', '-e', `
        const assert = require('node:assert/strict'), fs = require('node:fs');
        const { spawn } = require('node:child_process');
        const { withTransitionLock } = require('/media/scripts/transition-lock.cjs');
        (async () => {
          const inode = fs.statSync('/opt/commerce/.transition.lock').ino;
          const child = spawn(process.execPath, ['-e', "require('/media/scripts/transition-lock.cjs').withTransitionLock('/opt/commerce', async () => { process.stdout.write('ready'); await new Promise(() => { setInterval(() => {}, 1000); }); });"], { stdio: ['ignore', 'pipe', 'inherit'] });
          const exited = new Promise(resolve => child.once('exit', resolve));
          await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(Error('exited before lock'))); });
          child.kill('SIGKILL');
          await exited;
          const deadline = Date.now() + 3000;
          for (;;) {
            try { await withTransitionLock('/opt/commerce', async () => {}); break; }
            catch (error) {
              if (!String(error).includes('Another installation') || Date.now() > deadline) throw error;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          }
          assert.equal(fs.statSync('/opt/commerce/.transition.lock').ino, inode);
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `]);
      expect(crashed.exitCode, crashed.output).toBe(0);
      const descendant = await container.exec(['node', '-e', `
        const assert = require('node:assert/strict');
        const { spawn } = require('node:child_process');
        const { withTransitionLock } = require('/media/scripts/transition-lock.cjs');
        const fs = require('node:fs');
        fs.writeFileSync('/usr/local/bin/pg_restore', '#!/usr/local/bin/node\\nrequire("node:fs").writeFileSync("/tmp/pg-child-pid", String(process.pid)); setTimeout(() => {}, 30000);', { mode: 0o755 });
        (async () => {
          const code = "require('/media/scripts/transition-lock.cjs').withTransitionLock('/opt/commerce', async (_, fd) => { await require('/media/scripts/pg-tool.cjs').runPgTool('pg_restore', 'postgres://fixture:fixture@localhost/db', [], fd); });";
          const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
          const exited = new Promise(resolve => parent.once('exit', resolve));
          const readyDeadline = Date.now() + 5000;
          while (!fs.existsSync('/tmp/pg-child-pid')) {
            if (Date.now() > readyDeadline || parent.exitCode !== null) throw Error('native tool did not become ready');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          const pid = Number(fs.readFileSync('/tmp/pg-child-pid', 'utf8'));
          parent.kill('SIGKILL');
          await exited;
          try {
            await assert.rejects(withTransitionLock('/opt/commerce', async () => { throw Error('entered while migration child alive'); }), /Another installation/);
          } finally { process.kill(pid, 'SIGKILL'); }
          const deadline = Date.now() + 3000;
          for (;;) {
            try { await withTransitionLock('/opt/commerce', async () => {}); break; }
            catch (error) {
              if (!String(error).includes('Another installation') || Date.now() > deadline) throw error;
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `]);
      expect(descendant.exitCode, descendant.output).toBe(0);

      const installed = await container.exec(['bash', '-c', 'umask 000; /media/scripts/install.sh']);
      expect(installed.exitCode, installed.output).toBe(0);
      const check = await container.exec(['node', '-e', `
        const fs = require('node:fs');
        if (fs.readlinkSync('/opt/commerce/current') !== '/opt/commerce/releases/1.0.0') throw Error('wrong current');
        if (fs.existsSync('/opt/commerce/previous')) throw Error('unexpected previous');
        if ((fs.statSync('/etc/commerce/commerce.env').mode & 0o777) !== 0o640) throw Error('wrong secret mode');
        fs.writeFileSync('/media/VERSION', '1.0.1');
      `]);
      expect(check.exitCode, check.output).toBe(0);
      for (const kind of ['symlink', 'dangling', 'file', 'directory']) {
        const setup = await container.exec(['node', '-e', `
          const fs = require('node:fs');
          fs.rmSync('/opt/commerce/current', { recursive: true, force: true });
          const kind = process.argv[1];
          if (kind === 'symlink') fs.symlinkSync('/opt/commerce/releases/1.0.0', '/opt/commerce/current');
          if (kind === 'dangling') fs.symlinkSync('/missing', '/opt/commerce/current');
          if (kind === 'file') fs.writeFileSync('/opt/commerce/current', 'preserve');
          if (kind === 'directory') fs.mkdirSync('/opt/commerce/current');
          console.log(fs.lstatSync('/opt/commerce/current').ino);
        `, kind]);
        expect(setup.exitCode, setup.output).toBe(0);
        const rejected = await container.exec(['bash', '/media/scripts/install.sh']);
        expect(rejected.exitCode).not.toBe(0);
        expect(rejected.output).toContain('Existing installation: use the upgrade command');
        const preserved = await container.exec(['node', '-e', `
          const fs = require('node:fs');
          if (fs.existsSync('/opt/commerce/releases/1.0.1')) throw Error('candidate installed');
          console.log(fs.lstatSync('/opt/commerce/current').ino);
        `]);
        expect(preserved.exitCode, preserved.output).toBe(0);
        expect(preserved.stdout).toBe(setup.stdout);
      }
    } finally { await container.stop(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
