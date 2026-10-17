import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { csrfTokenFor } from '@storeweave/identity';
import type { Actor } from '@storeweave/contracts';
import { bootstrapRelease } from '@storeweave/release/bootstrap';
import { release } from '../../packages/examples/notes/src/runtime';
import type { Note, NotesList } from '../../packages/examples/notes/src/types';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/notes';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { createTestDatabase } from './helpers';

it('takes a new author from registration through private editing, publication and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-example-'));
  const configPath = join(dir, 'notes.json');
  process.env.NOTES_TEST_SIGNING_KEY = Buffer.alloc(32, 9).toString('base64url');
  writeFileSync(configPath, JSON.stringify({
    version: 1, store: { id: 'notes-test', name: 'Notes' }, database: { url: await createTestDatabase() },
    logging: { level: 'error' }, storage: { localRoot: join(dir, 'storage') },
    security: { signingKeys: [{ id: 'test', secretRef: 'NOTES_TEST_SIGNING_KEY' }] },
  }));
  const boot = await bootstrapRelease(release, { configPath, loggerName: 'notes-test' });
  const { runtime } = boot;
  let app: Awaited<ReturnType<typeof createReleaseServer>> | undefined;
  let closed = false;
  try {
    await runtime.migrate();
    expect(await runtime.migrate()).toEqual([]);
    app = await createReleaseServer({ runtime, theme: boot.theme, httpAdapter, release: { version: release.version, configPath } });
    const register = async (email: string) => {
      const response = await app!.inject({ method: 'POST', url: '/register',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ email, password: 'notes-test-password', next: '/my-notes' }).toString() });
      expect(response.statusCode, response.body).toBe(303);
      const session = response.cookies.find(c => c.name === SESSION_COOKIE)!.value;
      const resolved = await runtime.auth.resolveSession(runtime.database.db, session);
      const actor: Actor = { id: `user:${resolved!.user.id}`, type: 'user', permissions: release.roles.member!.permissions };
      return { session, actor };
    };
    const alice = await register('alice@example.test');
    const bob = await register('bob@example.test');
    const request = (url: string, session?: string) => app!.inject({ url, cookies: session ? { [SESSION_COOKIE]: session } : {} });
    const post = (url: string, session: string, fields: Record<string, string>, csrf = true) => app!.inject({ method: 'POST', url,
      cookies: { [SESSION_COOKIE]: session }, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...fields, ...(csrf ? { _csrf: csrfTokenFor(session) } : {}) }).toString() });
    for (const url of ['/api/v1/products', '/api/v1/content/articles', '/admin']) expect((await request(url)).statusCode).toBe(404);
    expect((await request('/my-notes')).statusCode).toBe(303);
    expect((await request('/notes')).statusCode).toBe(200);
    const editor = await request('/my-notes/new', alice.session);
    const operationId = /name="operationId" value="([^"]+)"/.exec(editor.body)![1]!;
    const fields = { operationId, title: '<script>title</script>', body: 'First paragraph\nSecond paragraph' };
    expect((await post('/my-notes', alice.session, fields, false)).statusCode).toBe(403);
    expect((await post('/my-notes', alice.session, fields)).statusCode).toBe(303);
    expect((await post('/my-notes', alice.session, fields)).statusCode).toBe(303);
    const mine = await runtime.queries.execute<NotesList>('notes.entry.listMine', {}, { actor: alice.actor });
    expect(mine.items).toHaveLength(1);
    let note = mine.items[0]!;
    const bobsNote = await runtime.commands.execute<Note>('notes.entry.create', { title: 'Bob', body: 'Private' },
      { actor: bob.actor, idempotencyKey: operationId });
    expect(bobsNote.id).not.toBe(note.id);
    expect(note.status).toBe('draft');
    expect((await request(`/notes/${note.id}`)).statusCode).toBe(404);
    expect((await request(`/my-notes/${note.id}`, bob.session)).statusCode).toBe(404);
    expect((await request('/my-notes', bob.session)).body).not.toContain(note.id);
    expect((await post(`/my-notes/${note.id}/publish`, bob.session, { operationId: randomUUID(), revision: '1' })).statusCode).toBe(404);
    await expect(runtime.queries.execute('notes.entry.getMine', { id: note.id }, { actor: { ...bob.actor, permissions: ['*'] } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.commands.execute('notes.entry.create', { title: 'x', body: 'y' }, { actor: { ...bob.actor, permissions: [] }, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // A stale revision cannot overwrite a newer edit; the public route still has no draft.
    const update = { operationId: randomUUID(), revision: '1', title: fields.title, body: 'Updated <b>plain text</b>' };
    expect((await post(`/my-notes/${note.id}`, alice.session, update)).statusCode).toBe(303);
    expect((await post(`/my-notes/${note.id}`, alice.session, { ...update, operationId: randomUUID() })).statusCode).toBe(409);
    const publishing = { operationId: randomUUID(), revision: '2' };
    expect((await post(`/my-notes/${note.id}/publish`, alice.session, publishing)).statusCode).toBe(303);
    expect((await post(`/my-notes/${note.id}/publish`, alice.session, publishing)).statusCode).toBe(303);
    note = await runtime.queries.execute<Note>('notes.entry.getMine', { id: note.id }, { actor: alice.actor });
    expect(note.revision).toBe(3);
    expect((await request('/notes')).body).toContain(note.id);
    const publicPage = await request(`/notes/${note.id}`);
    expect(publicPage.statusCode).toBe(200);
    expect(publicPage.body).toContain('&lt;script&gt;title&lt;/script&gt;');
    expect(publicPage.body).toContain('&lt;b&gt;plain text&lt;/b&gt;');
    expect(publicPage.body).not.toContain('<script>title');
    expect((await post(`/my-notes/${note.id}`, alice.session, { ...update, operationId: randomUUID(), revision: '3' })).statusCode).toBe(409);

    expect((await post(`/my-notes/${note.id}/unpublish`, alice.session, { operationId: randomUUID(), revision: '3' })).statusCode).toBe(303);
    expect((await request(`/notes/${note.id}`)).statusCode).toBe(404);
    expect((await request('/notes')).body).not.toContain(note.id);
    const competing = await Promise.allSettled(['First concurrent edit', 'Second concurrent edit'].map(body =>
      runtime.commands.execute('notes.entry.update', { id: note.id, revision: 4, title: 'Concurrent', body },
        { actor: alice.actor, idempotencyKey: randomUUID() })));
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = competing.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('CONFLICT');
    const tables = await runtime.database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    expect(tables.rows.some(row => /^(content_|catalog_|order_)/.test(row.tablename))).toBe(false);
    expect(tables.rows.some(row => row.tablename === 'notes_entries')).toBe(true);
    await app.close(); app = undefined;
    await runtime.close(); closed = true;
    const restarted = await bootstrapRelease(release, { configPath, loggerName: 'notes-restart' });
    try {
      await restarted.runtime.migrate();
      expect(await restarted.runtime.queries.execute('notes.entry.getMine', { id: note.id }, { actor: alice.actor }))
        .toMatchObject({ id: note.id, status: 'draft', revision: 5 });
    } finally { await restarted.runtime.close(); }
  } finally {
    await app?.close();
    if (!closed) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
