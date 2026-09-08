import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Linux native releases share this persistent flock inode with install.sh. Never unlink the lock file. */
export async function withTransitionLock<T>(home: string, action: (directory: string, lockFd: number) => Promise<T>): Promise<T> {
  home = resolve(home);
  // Native home has an existing parent; persist its entry before exposing operation state.
  try { mkdirSync(home, { mode: 0o755 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const parent = lstatSync(home);
  if (!parent.isDirectory() || parent.uid !== process.geteuid?.() || (parent.mode & 0o022) !== 0) throw new Error('Installation home must be an owned directory without group/world write access');
  const fd = openSync(join(home, '.transition.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.geteuid?.() || (file.mode & 0o022) !== 0) throw new Error('Transition lock must be a regular file without extra links');
    // flock attaches to the shared open-file description. This CLI retains fd after the helper exits.
    const locker = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'],
      { stdio: ['ignore', 'pipe', 'pipe', fd], env: { PATH: process.env.PATH } });
    let failure = '';
    locker.stderr?.on('data', chunk => { failure = (failure + chunk).slice(-4096); });
    await new Promise<void>((resolve, reject) => {
      locker.once('error', reject);
      locker.once('exit', code => code === 0 ? resolve() : reject(new Error(code === 75
        ? 'Another installation or release transition is running' : `Transition lock failed (${code}): ${failure.trim()}`)));
    });
    const directory = join(home, '.transitions');
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.geteuid?.()) throw new Error('Transition directory must be an owned 0700 directory');
    for (const path of [directory, home, dirname(home)]) {
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    return await action(directory, fd);
  } finally { closeSync(fd); }
}
