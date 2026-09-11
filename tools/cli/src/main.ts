#!/usr/bin/env node
import { createLegacyBridgeJournal, readLegacyBridgeJournal, advanceLegacyBridgeJournal } from './legacy-bridge-journal';
import { createLegacySafetySnapshot, readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { createLegacyPairedSnapshot, readLegacyPairedSnapshot } from './legacy-paired-snapshot';
import { verifyRestoredDatabase } from './verify-restored-database';
import { verifySourceRuntime } from './verify-source-runtime';
import { createPairedSnapshot } from './release-snapshot';
import { createUpgradeJournal, readUpgradeJournal, requireUpgradeDatabase, writeUpgradeJournal } from './upgrade-journal';
import { runReleaseCli } from './run-release-cli';
import { readPairedSnapshot } from './read-release-snapshot';
import { readRestoreJournal } from './restore-journal';
import { restoreSnapshotToScratch } from './restore-release-snapshot';
import { resumeRestoreCutover } from './resume-restore';
import { parsePgUrl } from './pg-tool';
import { withTransitionLock } from './transition-lock';
import { randomUUID } from 'node:crypto';

import { baselineMigrations, catalogDigest, readSnapshotDatabase } from '@storeweave/db';
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { bootstrapRelease } from '@storeweave/bootstrap-release';
import { release } from '@storeweave/selected-release';
import { doctor as runDoctorChecks, type Runtime } from '@storeweave/kernel';
import { loadReleaseConfig } from '@storeweave/config';
import { bold, dim, fail, heading, line, red, statusIcon, yellow } from './output';
import { resolvePaths } from './paths';
import { installReleaseArchive, validateLegacyB01Directory, validateReleaseDirectory } from './release-validation';
import { runPgTool, writePgBackup } from './pg-tool';
import { SERVICES, serviceManager, startServices, statusServices, stopServices } from './service';
import { LegacyContentMediaBackfill } from '@storeweave/content';

interface ScheduleListItem {
  type: string;
  kind: 'interval' | 'cron';
  expression: string;
  timezone: string | null;
  catchUp: number;
  overlap: string;
  paused: boolean;
  lastOccurrenceAt: string | null;
  nextOccurrenceAt: string | null;
  skippedCatchup: number;
  skippedPaused: number;
  skippedOverlap: number;
  consecutiveOverlapSkips: number;
}

const RELEASE_VERSION = process.env.STOREWEAVE_RELEASE_VERSION ?? process.env.COMMERCE_RELEASE_VERSION ?? release.version;

const RELEASE_NAME = release.id === 'commerce' ? 'commerce' : 'storeweave';

async function withRuntime<T>(fn: (runtime: Runtime, configPath: string) => Promise<T>): Promise<T> {
  const paths = resolvePaths(release.id);
  // 日誌走 stderr：`--json` 的輸出得能直接餵給 jq，混進一行 log 就整份解析失敗。
  const { runtime, loaded } = await bootstrapRelease(release, {
    configPath: paths.configFile, loggerName: `${RELEASE_NAME}-cli`, logDestination: 'stderr',
  });
  try {
    return await fn(runtime, loaded.sourcePath);
  } finally {
    await runtime.close();
  }
}

const program = new Command();
program
  .name(RELEASE_NAME)
  .description('StoreWeave release 維運指令')
  .version(RELEASE_VERSION);

program
  .command('install')
  .description('建立目錄、放置設定範本並套用 migration')
  .option('--config <path>', `要複製的 ${RELEASE_NAME}.yaml 範本`)
  .option('--env <path>', `要複製的 ${RELEASE_NAME}.env 範本`)
  .option('--skip-migrate', '只做檔案準備，不連資料庫')
  .action(async (options: { config?: string; env?: string; skipMigrate?: boolean }) => {
    const paths = resolvePaths(release.id);
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
    const validation = (() => {
      try { return { ok: true as const, config: loadReleaseConfig(release.config, paths.configFile).config }; }
      catch (error) { return { ok: false as const, errors: [(error as Error).message] }; }
    })();
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
    });
    heading('安裝完成');
    line(`  接著執行 ${bold(`${RELEASE_NAME} start`)} 啟動服務，再用 ${bold(`${RELEASE_NAME} doctor`)} 檢查。`);
  });

program.command('start').description('啟動 API 與 Worker').action(async () => printServices(await startServices()));
program.command('stop').description('停止 API 與 Worker').action(async () => printServices(await stopServices()));
program.command('restart').description('重新啟動 API 與 Worker').action(async () => {
  await stopServices();
  printServices(await startServices());
});
program.command('status').description('顯示服務狀態').action(() => printServices(statusServices()));

program
  .command('doctor')
  .description('檢查安裝、設定、資料庫、Worker、佇列與 Extension 狀態')
  .option('--json', '以 JSON 輸出')
  .action(async (options: { json?: boolean }) => {
    const paths = resolvePaths(release.id);
    const checks = await withRuntime(async (runtime, configPath) => {
      try { await runtime.activateRelease('require-current'); }
      catch (error) { return [{ name: 'release activation', status: 'fail' as const, detail: (error as Error).message }]; }
      return runDoctorChecks(runtime, { releaseVersion: RELEASE_VERSION, configPath });
    });
    const services = statusServices().map((s) => ({
      name: `service: ${s.name}`,
      status: (s.running ? 'pass' : 'warn') as 'pass' | 'warn',
      detail: `${s.detail} (${s.manager})`,
    }));
    const all = [...checks, ...services];

    if (options.json) {
      line(JSON.stringify({ release: RELEASE_VERSION, configFile: paths.configFile, checks: all }, null, 2));
    } else {
      heading(`${RELEASE_NAME} doctor  ${dim(`release ${RELEASE_VERSION}`)}`);
      for (const check of all) {
        line(`  ${statusIcon(check.status)}  ${check.name}${check.detail ? dim(` — ${check.detail}`) : ''}`);
      }
    }
    if (all.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

const migrateCommand = program
  .command('migrate')
  .description('套用尚未執行的資料庫 migration')
  .option('--status', '只顯示狀態，不執行')
  .option('--json', '以 JSON 輸出 --status，供復原流程核對')
  .action(async (options: { status?: boolean; json?: boolean }) => {
    if (options.json && !options.status) fail('--json requires --status');
    await withRuntime(async (runtime) => {
      if (options.status) {
        const status = await runtime.migrationStatus();
        if (options.json) { line(JSON.stringify(status)); return; }
        line(status.releaseCurrent ? 'Release 已啟用' : 'Release 尚待 migrate 啟用（包含無 SQL 的變更）');
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

migrateCommand.command('baseline')
  .description('明確採納 release 內固定的舊 migration catalog；不宣稱能證明歷史 SQL bytes')
  .requiredOption('--catalog <id>', '固定 catalog id')
  .requiredOption('--evidence <text>', '操作者與來源 release／備份驗證證據')
  .action(async (options: { catalog: string; evidence: string }) => {
    const baseline = release.legacyBaselines.find(baseline => baseline.id === options.catalog);
    if (!baseline) throw new Error(`Unknown legacy catalog "${options.catalog}" for release "${release.id}"`);
    await withRuntime(async runtime => {
      const result = await baselineMigrations(runtime.database.pool, runtime.migrations, baseline, options.evidence,
        runtime.config.extensions.filter(entry => entry.enabled).map(entry => entry.id));
      line(JSON.stringify(result));
    });
  });

program
  .command('content:backfill-legacy-media')
  .description('匯入預設 Theme 的舊文章圖片；可安全重跑，待 Worker 完成後再執行一次以附掛文章')
  .requiredOption('--assets-dir <path>', '含 woven-day-*.png 的已驗證 Theme assets 目錄')
  .action(async (options: { assetsDir: string }) => {
    const manifest = release.legacyContentMediaManifest;
    if (release.id !== 'commerce' || !manifest) fail('此 manifest 只屬於舊 Commerce Default Theme；Base 沒有可回填的 Theme 圖片');
    const assetsDir = resolve(options.assetsDir);
    for (const entry of manifest) {
      const asset = resolve(assetsDir, entry.file);
      if (!asset.startsWith(`${assetsDir}/`)) fail(`不安全的 Theme asset path：${entry.file}`);
    }
    await withRuntime(async runtime => {
      await runtime.activateRelease('require-current');
      const operation = new LegacyContentMediaBackfill(runtime.database, runtime.media, runtime.media.references, {
        open: async entry => ({ stream: createReadStream(resolve(assetsDir, entry.file)), contentType: 'image/png' }),
      });
      const report = await operation.run(manifest);
      const reconciliation = await operation.reconcile(manifest);
      line(JSON.stringify({ report, reconciliation }, null, 2));
      if (report.failed.length || report.waiting || reconciliation.unmappedKeys.length || reconciliation.incompleteKeys.length) process.exitCode = 2;
    });
  });


program
  .command('backup')
  .description('以 pg_dump 備份資料庫')
  .option('--out <file>', '輸出檔案路徑')
  .action(async (options: { out?: string }) => {
    const paths = resolvePaths(release.id);
    await withRuntime(async (runtime) => {
      const dir = runtime.config.paths.backupDir;
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = options.out ? resolve(options.out) : join(dir, `${runtime.config.store.id}-${stamp}.dump`);
      requireBinary('pg_dump');
      requireBinary('pg_restore');
      const dumped = await writePgBackup(runtime.config.database.url, target);
      if (dumped.stderr) process.stderr.write(dumped.stderr);
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
      const restored = await runPgTool('pg_restore', runtime.config.database.url, ['--clean', '--if-exists', '--no-owner', target]);
      if (restored.stderr) process.stderr.write(restored.stderr);
      heading('還原完成');
      line(`  ${dim('請接著執行')} ${RELEASE_NAME} migrate ${dim('與')} ${RELEASE_NAME} doctor`);
    });
  });

program
  .command('upgrade')
  .description('保存配對快照後套用新版 migration，或重試同一候選版本')
  .option('--from-legacy-b01', '明確從 Commerce B01 升級，必須直接執行候選 B02 CLI')
  .option('--catalog <id>', 'B01 固定 migration catalog')
  .option('--evidence <text>', 'B01 採納來源與操作者證據')
  .option('--safety <directory>', '繼續尚無日誌的 B01 原始備份，搭配 --checksum')
  .option('--release <tarball>', 'Release tarball 路徑')
  .option('--resume <journal>', '從既有 upgrade journal 重試')
  .option('--snapshot <directory>', '從已發布但尚無日誌的配對快照繼續')
  .option('--checksum <digest>', '配對快照記錄的 manifest checksum')
  .option('--external-writers-stopped', '確認外部寫入者已停止，並維持停止直到操作完成')
  .option('--no-restart', '不自動重啟服務')
  .action(async (options: { release?: string; resume?: string; snapshot?: string; checksum?: string; externalWritersStopped?: boolean; restart: boolean; fromLegacyB01?: boolean; catalog?: string; evidence?: string; safety?: string }) => {
    if (!options.externalWritersStopped) fail('upgrade requires --external-writers-stopped');
    if (options.fromLegacyB01) {
      const paths = resolvePaths(release.id);
      return withTransitionLock(paths.home, (directory, lockFd) => upgradeLegacyB01(options, directory, lockFd));
    }
    if (options.catalog || options.evidence || options.safety) fail('Legacy options require --from-legacy-b01');
    if ([options.release, options.resume, options.snapshot].filter(Boolean).length !== 1 || Boolean(options.snapshot) !== Boolean(options.checksum)) {
      fail('Use --release, --resume, or --snapshot with --checksum');
    }
    const paths = resolvePaths(release.id);
    return withTransitionLock(paths.home, async (directory, lockFd) => {
      let recorded = options.resume ? await readUpgradeJournal(options.resume, directory) : undefined;
      const loaded = loadReleaseConfig(release.config, paths.configFile);
      if (!isSymlink(paths.currentLink)) fail('current must be an existing source symlink');
      if (options.snapshot) {
        const pair = await readPairedSnapshot(options.snapshot, options.checksum!);
        if (pair.manifest.source.releaseId !== release.id
          || ![pair.manifest.source.directory, pair.manifest.candidate.directory].map(path => realpathSync(path)).includes(realpathSync(paths.currentLink))) fail('current does not match the upgrade source or candidate');
        await stopServices();
        await verifyRestoredDatabase(pair.directory, options.checksum!, loaded.config.database.url, pair.manifest.evidence.database.oid);
        await verifySourceRuntime(pair.directory, options.checksum!, paths.configFile, loaded.config.database.url, lockFd);
        await verifyRestoredDatabase(pair.directory, options.checksum!, loaded.config.database.url, pair.manifest.evidence.database.oid);
        recorded = await readUpgradeJournal(await createUpgradeJournal(directory, pair.directory, options.checksum!), directory);
      }
      if (!recorded) {
        requireBinary('tar'); requireBinary('pg_dump'); requireBinary('pg_restore');
        const source = validateReleaseDirectory(realpathSync(paths.currentLink), release.id);
        heading('驗證並準備候選 Release');
        const candidate = installReleaseArchive(resolve(options.release!), paths.releasesDir, release.id, true);
        await stopServices();
        const pair = await withRuntime(runtime => createPairedSnapshot({ databaseUrl: loaded.config.database.url,
          sourceDirectory: source.directory, candidateDirectory: candidate.directory, snapshotDirectory: directory, lockFd },
          callback => runtime.withReleaseSnapshot(callback)));
        line(`  snapshot：${pair.directory}`);
        line(`  checksum：${pair.manifestChecksum}`);
        const file = await createUpgradeJournal(directory, pair.directory, pair.manifestChecksum);
        recorded = await readUpgradeJournal(file, directory);
      }
      const { file, journal, snapshot: pair } = recorded;
      if (pair.manifest.source.releaseId !== release.id
        || ![pair.manifest.source.directory, pair.manifest.candidate.directory].map(path => realpathSync(path)).includes(realpathSync(paths.currentLink))) {
        fail('current does not match the upgrade source or candidate');
      }
      line(`  upgrade journal：${file}`);
      await stopServices();
      await requireUpgradeDatabase(pair, loaded.config.database.url);
      writeUpgradeJournal(file, { ...journal, phase: 'migrating' }, directory);
      runReleaseCli(pair.manifest.candidate, paths.configFile, loaded.config.database.url, 'migrate', lockFd);
      const status = JSON.parse(runReleaseCli(pair.manifest.candidate, paths.configFile, loaded.config.database.url, 'status', lockFd));
      if (status.releaseCurrent !== true || !Array.isArray(status.pending) || status.pending.length !== 0) throw new Error('Candidate release is not current after migration');
      await readPairedSnapshot(pair.directory, journal.snapshot.checksum);
      await requireUpgradeDatabase(pair, loaded.config.database.url);
      writeUpgradeJournal(file, { ...journal, phase: 'migrated' }, directory);
      switchSymlink(paths.currentLink, pair.manifest.candidate.directory);
      writeUpgradeJournal(file, { ...journal, phase: 'activated' }, directory);
      heading(`current -> ${pair.manifest.candidate.directory}`);
      if (options.restart !== false) printServices(await startServices());
    });
  });

program
  .command('rollback')
  .option('--safety <directory>', '還原 B01 採納前原始備份，需 --to-legacy-b01 與 --checksum')
  .option('--to-legacy-b01', '明確以候選 B02 CLI 還原配對的 B01 資料庫與程式')
  .description('以配對快照還原資料庫與來源版本，或繼續已記錄的還原')
  .option('--snapshot <directory>', '配對快照目錄')
  .option('--checksum <digest>', '快照記錄的 manifest checksum')
  .option('--resume <journal>', '繼續既有 restore journal')
  .option('--maintenance-database <name>', '獨立 maintenance 資料庫', 'postgres')
  .option('--yes', '確認將目前資料庫替換為快照內容')
  .option('--external-writers-stopped', '確認外部寫入者已停止，並維持停止直到操作完成')
  .option('--no-restart', '完成後不自動重啟服務')
  .action(async (options: { safety?: string; snapshot?: string; checksum?: string; resume?: string; maintenanceDatabase: string;
    yes?: boolean; externalWritersStopped?: boolean; restart: boolean; toLegacyB01?: boolean }) => {
    if (!options.yes || !options.externalWritersStopped) fail('rollback requires --yes and --external-writers-stopped');
    if (options.safety && !options.toLegacyB01) fail('Raw B01 restore requires --to-legacy-b01');
    if (options.resume ? Boolean(options.snapshot || options.safety || options.checksum) : [options.snapshot, options.safety].filter(Boolean).length !== 1 || !options.checksum) {
      fail('Use --snapshot or --safety with --checksum, or --resume with an existing journal');
    }
    const paths = resolvePaths(release.id);
    return withTransitionLock(paths.home, async (directory, lockFd) => {
      const resumed = options.resume ? await readRestoreJournal(options.resume, directory) : undefined;
      if (resumed && (resumed.journal.kind !== 'restore') !== Boolean(options.toLegacyB01)) fail('Restore journal requires its matching explicit legacy mode');
      const readSnapshot = options.safety ? readLegacySafetySnapshot : options.toLegacyB01 ? readLegacyPairedSnapshot : readPairedSnapshot;
      const pair = resumed?.snapshot ?? await readSnapshot((options.safety ?? options.snapshot)!, options.checksum!);
      if (options.toLegacyB01) {
        const executing = validateReleaseDirectory(dirname(dirname(realpathSync(process.argv[1]!))), 'commerce');
        const releases = realpathSync(paths.releasesDir);
        if (release.id !== 'commerce' || executing.version !== release.version || executing.treeChecksum !== pair.manifest.candidate.treeChecksum
          || dirname(realpathSync(pair.manifest.source.directory)) !== releases
          || dirname(realpathSync(pair.manifest.candidate.directory)) !== releases) fail('B01 rollback requires its exact installation-local candidate CLI and source');
      }
      if (pair.manifest.source.releaseId !== release.id) fail('Snapshot release identity does not match this CLI');
      if (!isSymlink(paths.currentLink) || ![pair.manifest.source.directory, pair.manifest.candidate.directory].map(path => realpathSync(path)).includes(realpathSync(paths.currentLink))) {
        fail('current does not match the snapshot source or candidate');
      }
      const loaded = loadReleaseConfig(release.config, paths.configFile);
      const maintenance = parsePgUrl(loaded.config.database.url);
      if (!options.maintenanceDatabase || Buffer.byteLength(options.maintenanceDatabase) > 63 || options.maintenanceDatabase.includes('\0')) fail('Invalid maintenance database name');
      if (decodeURIComponent(maintenance.pathname.slice(1)) !== pair.manifest.evidence.database.name) fail('Configured database does not match the snapshot source');
      maintenance.pathname = `/${encodeURIComponent(options.maintenanceDatabase)}`;
      if (options.maintenanceDatabase === pair.manifest.evidence.database.name) fail('Maintenance database must differ from the live database');
      if (!resumed) requireBinary('pg_restore');
      heading('停止並等待目前 API／Worker 結束');
      await stopServices();
      const journalFile = resumed?.file ?? (await restoreSnapshotToScratch(pair.directory, options.checksum!,
        maintenance.toString(), directory, lockFd, options.safety ? 'legacy-b01-safety' : options.toLegacyB01 ? 'legacy-b01' : 'modern')).journalFile;
      line(`  restore journal：${journalFile}`);
      const restored = await resumeRestoreCutover(resumed ?? await readRestoreJournal(journalFile, directory), maintenance.toString(), paths.configFile, lockFd);
      switchSymlink(paths.currentLink, restored.sourceDirectory);
      heading(`current -> ${restored.sourceDirectory}`);
      line(`  保留原資料庫：${restored.quarantineName}`);
      if (options.restart !== false) printServices(await startServices());
    });
  });

program
  .command('user:create')
  .description('建立後台操作者帳號（第一個管理員由這裡產生）')
  .requiredOption('--email <email>', '登入用的 email')
  .requiredOption('--name <name>', '顯示名稱')
  .option('--role <role>', '角色：admin / staff / readonly', 'admin')
  .action(async (options: { email: string; name: string; role: string }) => {
    // 密碼只從環境變數讀：寫在命令列會留在 shell history 與 ps 輸出裡。
    const password = process.env.COMMERCE_USER_PASSWORD;
    if (!password) {
      fail('請用環境變數提供密碼：COMMERCE_USER_PASSWORD=... commerce user:create ...');
      return;
    }
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const user = await runtime.commands.execute<{ id: string; email: string; role: string }>(
        'platform.identity.createUser',
        { email: options.email, password, displayName: options.name, role: options.role },
        { actor: runtime.actorForRole('system'), idempotencyKey: `cli-user-${options.email}` },
      );
      heading('已建立帳號');
      line(`  ${bold(user.email)} ${dim(`role=${user.role} id=${user.id}`)}`);
      line(dim('  用這組帳密登入管理後台；機器對機器請用 token:create 簽發。'));
    });
  });

program
  .command('token:create')
  .description('簽發機器對機器的 API token（秘密只顯示這一次）')
  .requiredOption('--name <name>', 'token 的名字，撤銷時用它指認')
  .requiredOption('--role <role>', '角色：必須是這個 release 允許給 token 的角色')
  .option('--expires-in-days <days>', '有效天數', '90')
  .option('--json', '以 JSON 輸出（部署腳本用）')
  .action(async (options: { name: string; role: string; expiresInDays: string; json?: boolean }) => {
    const days = Number(options.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      fail('--expires-in-days 必須是 1 到 3650 之間的整數');
      return;
    }
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const issued = await runtime.database.transaction(tx => runtime.apiTokens.issue(tx, {
        name: options.name, role: options.role, ttlMs: days * 24 * 60 * 60 * 1000, createdBy: 'cli',
      }));
      if (options.json) {
        process.stdout.write(`${JSON.stringify(issued)}\n`);
        return;
      }
      heading('已簽發 API token');
      line(`  ${bold(issued.name)} ${dim(`role=${issued.role} expires=${issued.expiresAt.toISOString()}`)}`);
      line(`  ${issued.secret}`);
      // 只存雜湊，所以這是唯一一次看得到它。抄不到就只能撤銷重發。
      line(dim('  這串秘密不會再顯示。請立刻存進部署的 secret 管理，不要寫進設定檔。'));
    });
  });

program
  .command('token:list')
  .description('列出 API token 的狀態（不含秘密）')
  .option('--json', '以 JSON 輸出')
  .action(async (options: { json?: boolean }) => {
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const tokens = await runtime.apiTokens.list(runtime.database.db);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(tokens, null, 2)}\n`);
        return;
      }
      heading('API token');
      if (tokens.length === 0) line(dim('  （沒有任何 token）'));
      for (const token of tokens) {
        const state = token.revokedAt ? 'revoked' : token.expiresAt.getTime() < Date.now() ? 'expired' : 'active';
        line(`  ${bold(token.name)} ${dim(`role=${token.role} ${state} expires=${token.expiresAt.toISOString()} last-used=${token.lastUsedAt?.toISOString() ?? 'never'}`)}`);
      }
    });
  });

program
  .command('token:revoke <name>')
  .description('立即撤銷一把 API token')
  .action(async (name: string) => {
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const revoked = await runtime.database.transaction(tx => runtime.apiTokens.revoke(tx, name));
      heading('已撤銷');
      line(`  ${bold(revoked.name)} ${dim(`role=${revoked.role}`)}`);
      line(dim('  下一個請求就不會通過，不需要重啟。'));
    });
  });

program
  .command('schedule:list')
  .description('列出週期性工作的排程與狀態')
  .option('--json', '以 JSON 輸出')
  .action(async (options: { json?: boolean }) => {
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const { items } = await runtime.queries.execute<{ items: ScheduleListItem[] }>(
        'platform.jobs.listSchedules', {}, { actor: runtime.actorForRole('system') },
      );
      if (options.json) {
        line(JSON.stringify({ items }, null, 2));
        return;
      }
      heading(`週期性工作（${items.length}）`);
      for (const item of items) {
        const when = item.kind === 'cron' ? `${item.expression} ${item.timezone}` : `every ${item.expression}ms`;
        line(`  ${bold(item.type)} ${dim(when)}${item.paused ? ' ' + bold('[paused]') : ''}`);
        line(`      ${dim('last      ')} ${item.lastOccurrenceAt ?? '(none)'}`);
        line(`      ${dim('next      ')} ${item.nextOccurrenceAt ?? '(none)'}`);
        line(`      ${dim('policy    ')} catchUp=${item.catchUp} overlap=${item.overlap}`);
        line(`      ${dim('skipped   ')} catchup=${item.skippedCatchup} paused=${item.skippedPaused} overlap=${item.skippedOverlap}`
          + (item.consecutiveOverlapSkips > 0 ? ` ${bold(`(overlap 連續 ${item.consecutiveOverlapSkips} 次)`)}` : ''));
      }
    });
  });

for (const [verb, commandName, description] of [
  ['pause', 'platform.jobs.pauseSchedule', '暫停一個週期性工作'],
  ['resume', 'platform.jobs.resumeSchedule', '恢復一個被暫停的週期性工作'],
] as const) {
  program
    .command(`schedule:${verb} <type>`)
    .description(description)
    .option('--idempotency-key <key>', '重試同一次操作時帶上同一個鍵，避免 audit 出現重複紀錄')
    .action(async (type: string, options: { idempotencyKey?: string }) => {
      await withRuntime(async (runtime) => {
        await runtime.activateRelease('require-current');
        // 固定鍵在這裡是錯的：暫停／恢復是可以來回切換的意圖，「暫停→恢復→再暫停」的
        // 第三步會讀到第一步的快取回應而不執行。所以預設每次呼叫是新的意圖；
        // 真的要重試同一次操作（例如上一次連線中斷、不確定有沒有生效）就自己帶鍵。
        const idempotencyKey = options.idempotencyKey ?? `cli-schedule-${verb}-${type}-${randomUUID()}`;
        const result = await runtime.commands.execute<{ type: string; paused: boolean }>(
          commandName, { type },
          { actor: runtime.actorForRole('system'), idempotencyKey },
        );
        heading(result.paused ? '已暫停' : '已恢復');
        line(`  ${bold(result.type)}`);
      });
    });
}

interface InboxItem {
  id: string;
  reference: string;
  templateId: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

/**
 * 收件匣屬於某一個帳號，而 CLI 沒有登入的人。因此收件人是必填的：
 * 操作者明講要看誰的信箱，那筆讀取才有一個可稽核的對象。
 */
function inboxActor(recipient: string) {
  return { id: recipient, type: 'user' as const, displayName: `cli:${recipient}`, permissions: ['notifications:inbox'] };
}

program
  .command('notifications:list <recipient>')
  .description('讀取某個帳號的站內通知')
  .option('--unread', '只列出未讀')
  .option('--limit <n>', '筆數上限', '50')
  .option('--json', '以 JSON 輸出')
  .action(async (recipient: string, options: { unread?: boolean; limit: string; json?: boolean }) => {
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const result = await runtime.queries.execute<{ items: InboxItem[]; total: number; unread: number }>(
        'platform.notifications.listInbox',
        { unreadOnly: Boolean(options.unread), limit: Number(options.limit) },
        { actor: inboxActor(recipient) },
      );
      if (options.json) {
        line(JSON.stringify(result, null, 2));
        return;
      }
      heading(`站內通知（${result.total}，未讀 ${result.unread}）`);
      for (const item of result.items) {
        line(`  ${item.readAt ? dim('read  ') : bold('unread')} ${bold(item.title)} ${dim(`${item.templateId} ${item.createdAt}`)}`);
        line(`      ${dim(item.id)}`);
      }
    });
  });

program
  .command('notifications:read <recipient> <ids...>')
  .description('把某個帳號的站內通知標記為已讀')
  .action(async (recipient: string, ids: string[]) => {
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
      const result = await runtime.commands.execute<{ updated: number }>(
        'platform.notifications.markRead', { ids },
        { actor: inboxActor(recipient), idempotencyKey: `cli-notifications-read-${randomUUID()}` },
      );
      heading('已標記為已讀');
      line(`  ${bold(String(result.updated))} 筆`);
    });
  });

program
  .command('extension:list')
  .description('列出這個 Release 內建、且已在設定中啟用的 Extension')
  .option('--json', '以 JSON 輸出')
  .action(async (options: { json?: boolean }) => {
    await withRuntime(async (runtime) => {
      await runtime.activateRelease('require-current');
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

async function upgradeLegacyB01(options: { release?: string; resume?: string; safety?: string; snapshot?: string;
  checksum?: string; catalog?: string; evidence?: string; restart: boolean }, directory: string, lockFd: number) {
  if (release.id !== 'commerce' || options.snapshot || [options.release, options.resume, options.safety].filter(Boolean).length !== 1
    || Boolean(options.safety) !== Boolean(options.checksum)) fail('B01 bridge requires Commerce and --release, --resume, or --safety with --checksum');
  const baseline = release.legacyBaselines.find(entry => entry.id === 'legacy-commerce-0.1.0-pre-b02');
  if (!baseline || (options.resume ? Boolean(options.catalog || options.evidence)
    : options.catalog !== baseline.id || !options.evidence?.trim())) fail('B01 bridge requires its fixed --catalog and --evidence; resume uses recorded evidence');
  const paths = resolvePaths(release.id);
  const executing = validateReleaseDirectory(dirname(dirname(realpathSync(process.argv[1]!))), 'commerce');
  if (executing.version !== release.version) fail('Execute the exact B02 candidate CLI directly');
  let recorded = options.resume ? await readLegacyBridgeJournal(options.resume, directory) : undefined;
  let safety = recorded?.safety ?? (options.safety ? await readLegacySafetySnapshot(options.safety, options.checksum!) : undefined);
  if (!isSymlink(paths.currentLink)) fail('B01 current must be a source symlink');
  const current = realpathSync(paths.currentLink), releases = realpathSync(paths.releasesDir);
  if (dirname(current) !== releases) fail('B01 current must be inside this installation releases directory');
  if (!safety) {
    const source = validateLegacyB01Directory(current);
    const candidate = installReleaseArchive(resolve(options.release!), paths.releasesDir, 'commerce', true);
    if (candidate.version === source.version || candidate.treeChecksum !== executing.treeChecksum) fail('B01 bridge must run the exact distinct candidate release');
    requireBinary('pg_dump'); requireBinary('pg_restore');
    await stopServices();
    const created = await withRuntime(runtime => createLegacySafetySnapshot(runtime.database.pool, {
      databaseUrl: runtime.config.database.url, sourceDirectory: source.directory, candidateDirectory: candidate.directory,
      operationRoot: directory, lockFd }));
    safety = await readLegacySafetySnapshot(created.directory, created.manifestChecksum);
    line(`  safety：${safety.directory}`);
    line(`  checksum：${safety.manifestChecksum}`);
  }
  if (safety.manifest.candidate.treeChecksum !== executing.treeChecksum
    || dirname(realpathSync(safety.manifest.source.directory)) !== releases
    || dirname(realpathSync(safety.manifest.candidate.directory)) !== releases
    || ![safety.manifest.source.directory, safety.manifest.candidate.directory].map(path => realpathSync(path)).includes(current)) fail('B01 bridge source or candidate differs from this installation');
  await stopServices();
  if (!recorded) recorded = await readLegacyBridgeJournal(await createLegacyBridgeJournal(directory, safety.directory,
    safety.manifestChecksum, options.evidence!), directory);
  line(`  bridge journal：${recorded.file}`);
  const file = recorded.file;
  await withRuntime(async runtime => {
    // Physical identity permits forward retry after partial SQL, but never a replacement database.
    await requireUpgradeDatabase(safety!, runtime.config.database.url);
    if (recorded!.journal.phase === 'safety') {
      requireBinary('pg_dump'); requireBinary('pg_restore');
      if (current !== realpathSync(safety!.manifest.source.directory)) fail('Unmigrated bridge must still use its B01 source');
      const client = await runtime.database.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL search_path = pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'");
        if (catalogDigest(await readSnapshotDatabase(client)) !== catalogDigest(safety!.manifest.evidence.database)) {
          fail('B01 database differs from its original safety snapshot');
        }
        const rows = await client.query("SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id), '[]'::jsonb) AS entries FROM (SELECT id, phase, applied_at FROM public.platform_migrations) m");
        if (catalogDigest(rows.rows[0].entries) !== safety!.manifest.evidence.migrationsChecksum) fail('B01 history differs from its original safety snapshot');
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      await baselineMigrations(runtime.database.pool, runtime.migrations, baseline!, recorded!.journal.evidence,
        runtime.config.extensions.filter(entry => entry.enabled).map(entry => entry.id));
      const pair = await createLegacyPairedSnapshot(runtime.database.pool, runtime.migrations, {
        databaseUrl: runtime.config.database.url, safetyDirectory: safety!.directory, safetyChecksum: safety!.manifestChecksum, evidence: recorded!.journal.evidence,
        operationRoot: directory, enabledExtensions: runtime.config.extensions.filter(entry => entry.enabled).map(entry => entry.id), lockFd });
      recorded = await advanceLegacyBridgeJournal(file, directory, 'paired', { directory: pair.directory, checksum: pair.manifestChecksum });
    }
    if (recorded!.journal.phase === 'paired') recorded = await advanceLegacyBridgeJournal(file, directory, 'migrating');
    if (recorded!.journal.phase === 'migrating') {
      runReleaseCli(safety!.manifest.candidate, paths.configFile, runtime.config.database.url, 'migrate', lockFd);
      recorded = await advanceLegacyBridgeJournal(file, directory, 'migrated');
    }
    const status = JSON.parse(runReleaseCli(safety!.manifest.candidate, paths.configFile, runtime.config.database.url, 'status', lockFd));
    if (status.releaseCurrent !== true || !Array.isArray(status.pending) || status.pending.length) fail('B01 candidate is not current after migration');
    recorded = await readLegacyBridgeJournal(file, directory);
    await requireUpgradeDatabase(recorded.snapshot!, runtime.config.database.url);
    switchSymlink(paths.currentLink, safety!.manifest.candidate.directory);
    if (recorded.journal.phase === 'migrated') await advanceLegacyBridgeJournal(file, directory, 'activated');
  });
  heading(`current -> ${safety.manifest.candidate.directory}`);
  if (options.restart !== false) printServices(await startServices());
}

function printServices(statuses: ReturnType<typeof statusServices>): void {
  heading(`服務狀態 ${dim(`(${serviceManager()})`)}`);
  for (const s of statuses) {
    line(`  ${statusIcon(s.running ? 'pass' : 'warn')}  ${s.name.padEnd(18)} ${s.detail}`);
  }
}

function switchSymlink(link: string, target: string): void {
  if ((existsSync(link) || isSymlink(link)) && !isSymlink(link)) throw new Error(`current must be a symlink: ${link}`);
  const tmp = `${link}.tmp-${randomUUID()}`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, link);
    const fd = openSync(dirname(link), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  finally { if (isSymlink(tmp)) unlinkSync(tmp); }
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
