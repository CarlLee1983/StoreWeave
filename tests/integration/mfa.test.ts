import { randomUUID } from 'node:crypto';
import { generateSync } from 'otplib';
import { doctor } from '@storeweave/kernel';
import { createKeyring } from '@storeweave/crypto';
import { MfaService } from '@storeweave/identity';
import { rewrapMfaSecrets } from '../../tools/cli/src/mfa-rewrap';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ACTOR, createHarness, type TestHarness } from './helpers';

const harnesses: TestHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
});

const PASSWORD = 'operator-password-1';

/**
 * 確認註冊會把當下的時間步記成「已用過」，所以真正的下一次登入必然落在下一個窗口。
 * 測試不等 30 秒，直接產生下一步的代碼——容忍度讓它現在就通得過。
 */
const nextCode = (secret: string) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

async function operator() {
  const harness = await createHarness();
  harnesses.push(harness);
  const email = `${randomUUID()}@example.test`;
  const user = await harness.runtime.commands.execute<{ id: string }>(
    'platform.identity.createUser',
    { email, password: PASSWORD, displayName: 'Operator', role: 'admin' },
    { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
  );
  return { harness, email, userId: user.id, db: harness.runtime.database.db };
}

async function enrol(context: Awaited<ReturnType<typeof operator>>) {
  const { harness, userId } = context;
  const enrolment = await harness.runtime.database.transaction(tx =>
    harness.runtime.mfa.beginEnrolment(tx, { userId, accountName: 'operator' }));
  const codes = await harness.runtime.database.transaction(tx =>
    harness.runtime.mfa.confirmEnrolment(tx, { userId, code: generateSync({ secret: enrolment.secret }) }));
  return { secret: enrolment.secret, uri: enrolment.uri, codes };
}

describe('operator multi-factor authentication', () => {
  it('lets an unenrolled operator in but marks the account as owing an enrolment', async () => {
    const context = await operator();
    const session = await context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD,
    });
    // 第一個管理員得先進得來才設定得了第二因素。
    expect(session.mfaEnrolmentRequired).toBe(true);
  });

  it('keeps the shared secret encrypted and out of the enrolment row', async () => {
    const context = await operator();
    const { secret, uri } = await enrol(context);
    expect(uri).toContain('otpauth://totp/');

    const stored = await context.harness.runtime.database.pool.query<{ secret: string }>(
      'SELECT secret FROM platform_user_mfa WHERE user_id = $1', [context.userId]);
    expect(stored.rows[0].secret.startsWith('swe1.')).toBe(true);
    expect(stored.rows[0].secret).not.toContain(secret);
  });

  it('requires a code once enrolment is confirmed and accepts a valid one', async () => {
    const context = await operator();
    const { secret } = await enrol(context);

    await expect(context.harness.runtime.auth.authenticate(context.db, { email: context.email, password: PASSWORD }))
      .rejects.toThrow(/multi-factor code is required/i);
    await expect(context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, mfaCode: '000000',
    })).rejects.toThrow(/multi-factor code is required/i);

    const session = await context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, mfaCode: nextCode(secret),
    });
    expect(session.token).toBeTruthy();
    expect(session.mfaEnrolmentRequired).toBeUndefined();
  });

  it('refuses the same code twice so a shoulder-surfed number cannot be replayed', async () => {
    const context = await operator();
    const { secret } = await enrol(context);
    const code = nextCode(secret);

    await context.harness.runtime.auth.authenticate(context.db, { email: context.email, password: PASSWORD, mfaCode: code });
    await expect(context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, mfaCode: code,
    })).rejects.toThrow(/multi-factor code is required/i);
  });

  it('spends a recovery code exactly once', async () => {
    const context = await operator();
    const { codes } = await enrol(context);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    const session = await context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, recoveryCode: codes[0],
    });
    expect(session.token).toBeTruthy();
    await expect(context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, recoveryCode: codes[0],
    })).rejects.toThrow(/multi-factor code is required/i);

    // 其餘的還在，用掉一個不等於整批作廢。
    const status = await context.harness.runtime.mfa.statusFor(context.db, context.userId);
    expect(status).toMatchObject({ enrolled: true, confirmed: true, recoveryCodesRemaining: 9 });
  });

  it('stores recovery codes as hashes only', async () => {
    const context = await operator();
    const { codes } = await enrol(context);
    const stored = await context.harness.runtime.database.pool.query<{ code_hash: string }>(
      'SELECT code_hash FROM platform_mfa_recovery_codes WHERE user_id = $1', [context.userId]);
    expect(stored.rows.map(row => row.code_hash)).not.toContain(codes[0]);
    expect(stored.rows.every(row => /^[0-9a-f]{64}$/.test(row.code_hash))).toBe(true);
  });

  it('rewraps every persistent MFA secret before an old encryption key is removed', async () => {
    const context = await operator();
    const keys = [
      { id: 'old', secret: '11'.repeat(32) },
      { id: 'new', secret: '22'.repeat(32) },
    ];
    const oldService = new MfaService(
      createKeyring({ activeKeyId: 'old', keys }),
      'StoreWeave',
    );
    const enrolment = await context.harness.runtime.database.transaction(tx =>
      oldService.beginEnrolment(tx, { userId: context.userId, accountName: 'operator' }));
    await context.harness.runtime.database.transaction(tx =>
      oldService.confirmEnrolment(tx, {
        userId: context.userId,
        code: generateSync({ secret: enrolment.secret }),
      }));

    const rotating = new MfaService(
      createKeyring({ activeKeyId: 'new', keys }),
      'StoreWeave',
    );
    const rotationRuntime = {
      activateRelease: context.harness.runtime.activateRelease.bind(context.harness.runtime),
      database: context.harness.runtime.database,
      mfa: rotating,
    };
    const report = await rewrapMfaSecrets(rotationRuntime);
    expect(report).toEqual({ total: 1, alreadyActive: 0, rewrapped: 1 });
    const stored = await context.harness.runtime.database.pool.query<{ secret: string }>(
      'SELECT secret FROM platform_user_mfa WHERE user_id = $1',
      [context.userId],
    );
    expect(stored.rows[0].secret).toMatch(/^swe1\.new\./);
    expect(await rewrapMfaSecrets(rotationRuntime)).toEqual({
      total: 1,
      alreadyActive: 1,
      rewrapped: 0,
    });
    const afterSecondRun = await context.harness.runtime.database.pool.query<{ secret: string }>(
      'SELECT secret FROM platform_user_mfa WHERE user_id = $1',
      [context.userId],
    );
    expect(afterSecondRun.rows[0].secret).toBe(stored.rows[0].secret);

    const afterRetirement = new MfaService(
      createKeyring({ activeKeyId: 'new', keys: [keys[1]] }),
      'StoreWeave',
    );
    await expect(afterRetirement.verifyForLogin(context.db, {
      userId: context.userId,
      code: nextCode(enrolment.secret),
    })).resolves.toBe(true);
  });

  it('rolls back the whole MFA rewrap when any persistent secret cannot be opened', async () => {
    const context = await operator();
    const second = await context.harness.runtime.commands.execute<{ id: string }>(
      'platform.identity.createUser',
      {
        email: `${randomUUID()}@example.test`,
        password: PASSWORD,
        displayName: 'Second operator',
        role: 'admin',
      },
      { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() },
    );
    const [validUserId, invalidUserId] = [context.userId, second.id].sort();
    const keys = [
      { id: 'old', secret: '11'.repeat(32) },
      { id: 'new', secret: '22'.repeat(32) },
    ];
    const oldService = new MfaService(
      createKeyring({ activeKeyId: 'old', keys }),
      'StoreWeave',
    );
    await context.harness.runtime.database.transaction(tx =>
      oldService.beginEnrolment(tx, { userId: validUserId, accountName: 'operator' }));
    await context.harness.runtime.database.pool.query(
      `INSERT INTO platform_user_mfa (user_id, secret) VALUES ($1, 'swe1.missing.invalid.invalid.invalid')`,
      [invalidUserId],
    );
    const before = await context.harness.runtime.database.pool.query<{ secret: string }>(
      'SELECT secret FROM platform_user_mfa WHERE user_id = $1',
      [validUserId],
    );
    const rotating = new MfaService(
      createKeyring({ activeKeyId: 'new', keys }),
      'StoreWeave',
    );

    await expect(context.harness.runtime.database.transaction(tx => rotating.rewrapSecrets(tx)))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const after = await context.harness.runtime.database.pool.query<{ secret: string }>(
      'SELECT secret FROM platform_user_mfa WHERE user_id = $1',
      [validUserId],
    );
    expect(after.rows[0].secret).toBe(before.rows[0].secret);
    expect(after.rows[0].secret).toMatch(/^swe1\.old\./);
  });

  it('replaces the whole batch when codes are reissued', async () => {
    const context = await operator();
    const { secret, codes } = await enrol(context);
    const reissued = await context.harness.runtime.database.transaction(tx =>
      context.harness.runtime.mfa.replaceRecoveryCodes(tx, context.userId));

    expect(reissued.some(code => codes.includes(code))).toBe(false);
    await expect(context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, recoveryCode: codes[0],
    })).rejects.toThrow(/multi-factor code is required/i);
    await expect(context.harness.runtime.auth.authenticate(context.db, {
      email: context.email, password: PASSWORD, recoveryCode: reissued[0],
    })).resolves.toBeDefined();
    expect(generateSync({ secret })).toMatch(/^\d{6}$/);
  });

  it('refuses to start a second enrolment while one is already confirmed', async () => {
    const context = await operator();
    await enrol(context);
    await expect(context.harness.runtime.database.transaction(tx =>
      context.harness.runtime.mfa.beginEnrolment(tx, { userId: context.userId, accountName: 'operator' })))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('counts the operators that still owe an enrolment, so the window is visible to operations', async () => {
    const context = await operator();
    const mfaCheck = async () => (await doctor(context.harness.runtime, { releaseVersion: 'test', configPath: '<test>' }))
      .find(check => check.name === 'operator mfa enrolment');

    // ADR 0044 讓未註冊的管理員仍然登得進來；補償是這個窗口在營運檢查裡看得見，
    // 而不是只出現在某一次登入回應的一個布林值裡。
    expect(await mfaCheck()).toMatchObject({ status: 'warn' });
    await enrol(context);
    expect(await mfaCheck()).toMatchObject({ status: 'pass' });
  });

  it('leaves a customer account untouched by the operator requirement', async () => {
    const context = await operator();
    const email = `${randomUUID()}@example.test`;
    await context.harness.runtime.commands.execute('commerce.customer.registerCustomer',
      { email, password: 'customer-pass', displayName: 'Shopper' },
      { actor: context.harness.runtime.actorForRole('storefront'), idempotencyKey: randomUUID() });

    const session = await context.harness.runtime.auth.authenticate(context.db, { email, password: 'customer-pass' });
    expect(session.mfaEnrolmentRequired).toBeUndefined();
  });
});
