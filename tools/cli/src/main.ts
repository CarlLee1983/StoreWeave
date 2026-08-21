#!/usr/bin/env node
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import { bootstrap } from '@storeweave/bundle';
import { doctor as runDoctorChecks, type Runtime } from '@storeweave/kernel';
import { validateConfigFile } from '@storeweave/config';
import { bold, dim, fail, heading, line, red, statusIcon, yellow } from './output';
import { resolvePaths } from './paths';
import { SERVICES, serviceManager, startServices, statusServices, stopServices } from './service';

const RELEASE_VERSION = process.env.COMMERCE_RELEASE_VERSION ?? '0.1.0';

async function withRuntime<T>(fn: (runtime: Runtime, configPath: string) => Promise<T>): Promise<T> {
  const paths = resolvePaths();
  const { runtime, loaded } = await bootstrap({ configPath: paths.configFile, loggerName: 'commerce-cli' });
  try {
    return await fn(runtime, loaded.sourcePath);
  } finally {
    await runtime.close();
  }
}

const program = new Command();
program
  .name('commerce')
  .description('StoreWeave 單站電商平台的統一維運指令')
  .version(RELEASE_VERSION);

program
  .command('install')
  .description('建立目錄、放置設定範本並套用 migration')
  .option('--config <path>', '要複製的 commerce.yaml 範本')
  .option('--env <path>', '要複製的 commerce.env 範本')
  .option('--skip-migrate', '只做檔案準備，不連資料庫')
  .action(async (options: { config?: string; env?: string; skipMigrate?: boolean }) => {
    const paths = resolvePaths();
    heading('建立目錄');
    for (const dir of [paths.configDir, paths.dataDir, paths.logDir, paths.runDir, join(paths.dataDir, 'backups'), paths.releasesDir]) {
      mkdirSync(dir, { recursive: true });
      line(`  ${dim('created')} ${dir}`);
    }

    if (options.config && !existsSync(paths.configFile)) {
      copyFileSync(resolve(options.config), paths.configFile);
      line(`  ${dim('config ')} ${paths.configFile}`);
    }
    if (options.env && !existsSync(paths.envFile)) {
      copyFileSync(resolve(options.env), paths.envFile);
      chmodSync(paths.envFile, 0o600);
      line(`  ${dim('secrets')} ${paths.envFile} (mode 0600)`);
    }

    if (!existsSync(paths.configFile)) {
      fail(`找不到 ${paths.configFile}。請用 --config 指定範本，或手動放置設定檔。`);
    }
    const validation = validateConfigFile(paths.configFile);
    if (!validation.ok) fail(validation.errors.join('\n'));
    line(`  ${dim('config ')} 設定檔通過 schema 驗證`);

    if (options.skipMigrate) {
      heading('完成（略過 migration）');
      return;
    }
    await withRuntime(async (runtime) => {
      const applied = await runtime.migrate();
      heading('Migration');
      line(applied.length ? applied.map((id) => `  ${id}`).join('\n') : `  ${dim('沒有待套用的 migration')}`);
      await runtime.extensions.persistRegistry();
    });
    heading('安裝完成');
    line(`  接著執行 ${bold('commerce start')} 啟動服務，再用 ${bold('commerce doctor')} 檢查。`);
  });

program.command('start').description('啟動 API 與 Worker').action(() => printServices(startServices()));
program.command('stop').description('停止 API 與 Worker').action(() => printServices(stopServices()));
program.command('restart').description('重新啟動 API 與 Worker').action(() => {
  stopServices();
  printServices(startServices());
});
program.command('status').description('顯示服務狀態').action(() => printServices(statusServices()));

program
  .command('doctor')
  .description('檢查安裝、設定、資料庫、Worker、佇列與 Extension 狀態')
  .option('--json', '以 JSON 輸出')
  .action(async (options: { json?: boolean }) => {
    const paths = resolvePaths();
    const checks = await withRuntime((runtime, configPath) =>
      runDoctorChecks(runtime, { releaseVersion: RELEASE_VERSION, configPath }),
    );
    const services = statusServices().map((s) => ({
      name: `service: ${s.name}`,
      status: (s.running ? 'pass' : 'warn') as 'pass' | 'warn',
      detail: `${s.detail} (${s.manager})`,
    }));
    const all = [...checks, ...services];

    if (options.json) {
      line(JSON.stringify({ release: RELEASE_VERSION, configFile: paths.configFile, checks: all }, null, 2));
    } else {
      heading(`commerce doctor  ${dim(`release ${RELEASE_VERSION}`)}`);
      for (const check of all) {
        line(`  ${statusIcon(check.status)}  ${check.name}${check.detail ? dim(` — ${check.detail}`) : ''}`);
      }
    }
    if (all.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

program
  .command('migrate')
  .description('套用尚未執行的資料庫 migration')
  .option('--status', '只顯示狀態，不執行')
  .action(async (options: { status?: boolean }) => {
    await withRuntime(async (runtime) => {
      if (options.status) {
        const status = await runtime.migrationStatus();
        heading('已套用');
        for (const m of status.applied) line(`  ${m.id} ${dim(`(${m.phase})`)}`);
        heading('待套用');
        line(status.pending.length ? status.pending.map((m) => `  ${m.id} ${dim(`(${m.phase})`)}`).join('\n') : `  ${dim('（無）')}`);
        return;
      }
      const applied = await runtime.migrate();
      heading('Migration');
      line(applied.length ? applied.map((id) => `  ${id}`).join('\n') : `  ${dim('沒有待套用的 migration')}`);
    });
  });

program
  .command('backup')
  .description('以 pg_dump 備份資料庫')
  .option('--out <file>', '輸出檔案路徑')
  .action(async (options: { out?: string }) => {
    const paths = resolvePaths();
    await withRuntime(async (runtime) => {
      const dir = runtime.config.paths.backupDir;
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = options.out ? resolve(options.out) : join(dir, `${runtime.config.store.id}-${stamp}.dump`);
      requireBinary('pg_dump');
      execFileSync('pg_dump', ['--format=custom', '--no-owner', '--file', target, runtime.config.database.url], { stdio: 'inherit' });
      chmodSync(target, 0o600);
      heading('備份完成');
      line(`  ${target}`);
      line(`  ${dim('設定檔請一併備份：')} ${paths.configFile}, ${paths.envFile}`);
    });
  });

program
  .command('restore')
  .description('從 pg_dump 備份還原資料庫（會覆寫現有資料）')
  .argument('<file>', '備份檔路徑')
  .option('--yes', '不詢問直接執行')
  .action(async (file: string, options: { yes?: boolean }) => {
    const target = resolve(file);
    if (!existsSync(target)) fail(`找不到備份檔：${target}`);
    if (!options.yes) fail('還原會覆寫現有資料。確認後請加上 --yes 再執行。');
    await withRuntime(async (runtime) => {
      requireBinary('pg_restore');
      execFileSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', runtime.config.database.url, target], { stdio: 'inherit' });
      heading('還原完成');
      line(`  ${dim('請接著執行')} commerce migrate ${dim('與')} commerce doctor`);
    });
  });

program
  .command('upgrade')
  .description('安裝新版 Release、套用 migration 並切換 current symlink')
  .requiredOption('--release <tarball>', 'Release tarball 路徑')
  .option('--no-restart', '不自動重啟服務')
  .action((options: { release: string; restart: boolean }) => {
    const paths = resolvePaths();
    const tarball = resolve(options.release);
    if (!existsSync(tarball)) fail(`找不到 release：${tarball}`);
    requireBinary('tar');

    const version = basename(tarball).replace(/\.tar\.gz$/, '').replace(/^commerce-/, '');
    const targetDir = join(paths.releasesDir, version);
    mkdirSync(paths.releasesDir, { recursive: true });
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });

    heading(`解壓 ${version}`);
    execFileSync('tar', ['-xzf', tarball, '-C', targetDir, '--strip-components=1'], { stdio: 'inherit' });

    const previous = existsSync(paths.currentLink) ? readlinkSync(paths.currentLink) : null;
    try {
      heading('套用 migration（使用新版程式）');
      execFileSync(join(targetDir, 'bin', 'commerce'), ['migrate'], { stdio: 'inherit', env: process.env });

      if (previous) writeFileSync(join(paths.home, 'previous'), previous, 'utf8');
      switchSymlink(paths.currentLink, targetDir);
      heading(`current -> ${targetDir}`);

      if (options.restart !== false) {
        stopServices();
        printServices(startServices());
      }
    } catch (err) {
      line(red('升級失敗，current symlink 保持指向舊版。'));
      line(dim(`  ${(err as Error).message}`));
      if (previous) line(dim(`  目前仍是：${previous}`));
      process.exit(1);
    }
  });

program
  .command('rollback')
  .description('把 current symlink 切回上一版並重啟服務')
  .option('--to <version>', '指定要切回的版本目錄名稱')
  .action((options: { to?: string }) => {
    const paths = resolvePaths();
    const previousFile = join(paths.home, 'previous');
    const target = options.to
      ? join(paths.releasesDir, options.to)
      : existsSync(previousFile) ? readFileSync(previousFile, 'utf8').trim() : null;

    if (!target) fail('找不到可回退的版本。請用 --to <version> 指定。');
    if (!existsSync(target)) fail(`版本目錄不存在：${target}`);

    const current = existsSync(paths.currentLink) ? readlinkSync(paths.currentLink) : null;
    switchSymlink(paths.currentLink, target);
    if (current) writeFileSync(previousFile, current, 'utf8');

    heading(`current -> ${target}`);
    line(yellow('  提醒：只有 expand/migrate 階段的 schema 能安全回退。'));
    line(yellow('  已執行過 contract 階段 migration 的版本無法用舊程式讀取。'));
    stopServices();
    printServices(startServices());
  });

program
  .command('extension:list')
  .description('列出這個 Release 內建、且已在設定中啟用的 Extension')
  .option('--json', '以 JSON 輸出')
  .action(async (options: { json?: boolean }) => {
    await withRuntime(async (runtime) => {
      const items = runtime.extensions.list().map((ext) => ({
        id: ext.id,
        name: ext.name,
        version: ext.version,
        platformVersion: ext.platformVersion,
        permissions: ext.permissions,
        subscribedEvents: ext.subscribedEvents,
        commands: ext.commands,
        queries: ext.queries,
        providers: ext.providers,
        mcpTools: ext.mcpTools,
      }));
      if (options.json) {
        line(JSON.stringify({ items }, null, 2));
        return;
      }
      heading(`已啟用的 Extension（${items.length}）`);
      for (const ext of items) {
        line(`  ${bold(ext.id)} ${dim(`v${ext.version} · platform ${ext.platformVersion}`)}`);
        line(`      ${dim('name      ')} ${ext.name}`);
        line(`      ${dim('permissions')} ${ext.permissions.join(', ') || '(none)'}`);
        line(`      ${dim('events    ')} ${ext.subscribedEvents.join(', ') || '(none)'}`);
        line(`      ${dim('commands  ')} ${ext.commands.join(', ') || '(none)'}`);
        line(`      ${dim('queries   ')} ${ext.queries.join(', ') || '(none)'}`);
        line(`      ${dim('providers ')} ${ext.providers.join(', ') || '(none)'}`);
        line(`      ${dim('mcp tools ')} ${ext.mcpTools.join(', ') || '(none)'}`);
      }
      const disabled = runtime.config.extensions.filter((e) => !e.enabled).map((e) => e.id);
      if (disabled.length) line(`\n  ${dim(`設定中停用：${disabled.join(', ')}`)}`);
    });
  });

function printServices(statuses: ReturnType<typeof statusServices>): void {
  heading(`服務狀態 ${dim(`(${serviceManager()})`)}`);
  for (const s of statuses) {
    line(`  ${statusIcon(s.running ? 'pass' : 'warn')}  ${s.name.padEnd(18)} ${s.detail}`);
  }
}

function switchSymlink(link: string, target: string): void {
  const tmp = `${link}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  symlinkSync(target, tmp);
  if (existsSync(link) || isSymlink(link)) unlinkSync(link);
  symlinkSync(target, link);
  unlinkSync(tmp);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function requireBinary(name: string): void {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
  } catch {
    fail(`找不到 ${name}，請先安裝 PostgreSQL client 工具。`);
  }
}

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message);
});
