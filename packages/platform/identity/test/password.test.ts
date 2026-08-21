import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../src/password';

describe('密碼雜湊', () => {
  it('同一組密碼每次雜湊的結果都不同（有 salt）', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toEqual(b);
  });

  it('雜湊結果不含明文密碼', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('正確密碼驗證通過', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('錯誤密碼驗證失敗', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
  });

  it('雜湊格式毀損時回報失敗而不是丟例外', async () => {
    await expect(verifyPassword('whatever', 'not-a-valid-hash')).resolves.toBe(false);
  });

  it('雜湊字串帶有成本參數，未來調參數才不必強制全體重設密碼', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.split(':').slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
  });

  it('用來擋帳號枚舉的假雜湊是合法雜湊，會真的跑完 scrypt', async () => {
    const dummy = await DUMMY_HASH;
    // 格式合法 —— 先前的假值 key 只有 3 bytes，長度檢查就提早返回，等時性根本沒發生
    await expect(verifyPassword('anything', dummy)).resolves.toBe(false);

    const time = async (hash: string) => {
      const start = process.hrtime.bigint();
      await verifyPassword('guess', hash);
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const real = await hashPassword('some other password');
    await time(real);
    const [realMs, dummyMs] = [await time(real), await time(dummy)];
    // 兩條路徑都要真的跑 scrypt；先前的差距是四個數量級
    expect(dummyMs).toBeGreaterThan(realMs / 5);
  });
});
