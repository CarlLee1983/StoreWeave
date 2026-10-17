import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from '@storeweave/contracts';
import { definePage, formValue, type PageOutcome, type PageResolveContext, type StorefrontHttpContract } from '@storeweave/kernel';
import type { Note, NotesList } from './types';

export interface ListView extends NotesList { own: boolean; offset: number }
export interface EditorView { note: Note | null; operationId: string; error?: string }
export interface DetailView { note: Note }
const html = (status: number | 'platform-error') => ({ kind: 'html', status, contentType: 'text/html; charset=utf-8', body: 'theme' }) as const;
const reads: StorefrontHttpContract['responses'] = [html(200), html(404), html('platform-error')];
const writes: StorefrontHttpContract['responses'] = [
  { kind: 'redirect', status: 303, location: { kind: 'fixed', value: '/my-notes' } }, html('platform-error'),
];
const uuid = { type: 'string', format: 'uuid' } as const;
const emptyContract = { kind: 'storefront', request: 'none', input: { type: 'object', properties: {}, additionalProperties: false }, responses: reads } as const;
const idContract = { ...emptyContract, params: { id: 'id' }, input: { type: 'object', properties: { id: uuid }, required: ['id'], additionalProperties: false } } as const;
const listInput = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) });
const listContract = {
  ...emptyContract, request: 'query',
  input: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, maximum: 100000 } }, additionalProperties: false },
} as const;
const idInput = z.object({ id: z.string().uuid() });

async function list(ctx: PageResolveContext, own: boolean, offset: number): Promise<PageOutcome<ListView>> {
  const result = await ctx.queries.execute<NotesList>(own ? 'notes.entry.listMine' : 'notes.entry.listPublished', { offset }, { actor: ctx.actor });
  return { kind: 'view', view: { ...result, own, offset } };
}
async function detail(ctx: PageResolveContext, id: string, own: boolean): Promise<PageOutcome<EditorView | DetailView>> {
  try {
    const note = await ctx.queries.execute<Note>(own ? 'notes.entry.getMine' : 'notes.entry.getPublished', { id }, { actor: ctx.actor });
    return { kind: 'view', view: own ? { note, operationId: randomUUID() } : { note } };
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'NOT_FOUND') return { kind: 'not-found' };
    throw error;
  }
}

const operation = { operationId: formValue.pipe(z.string().uuid()) };
const changeForm = { ...operation, id: z.string().uuid(), revision: formValue.pipe(z.coerce.number().int().positive()) };
const contentForm = { title: formValue, body: formValue };
const operationProperties = { operationId: uuid, _csrf: { type: 'string' } } as const;
const changeProperties = { ...operationProperties, id: uuid, revision: { type: 'integer', minimum: 1 } } as const;
const contentProperties = { title: { type: 'string', minLength: 1, maxLength: 160 }, body: { type: 'string', minLength: 1, maxLength: 10000 } } as const;

async function write(ctx: PageResolveContext, name: string, operationId: string, input: unknown): Promise<PageOutcome<never>> {
  await ctx.commands.execute(name, input, { actor: ctx.actor, correlationId: randomUUID(), idempotencyKey: operationId });
  return { kind: 'redirect', location: '/my-notes' };
}

export const notesPages = {
  publicList: definePage({ id: 'notes.entry.index', path: '/notes', method: 'get', audience: 'public', input: listInput,
    contract: listContract, resolve: (ctx, input) => list(ctx, false, input.offset) }),
  publicDetail: definePage({ id: 'notes.entry.view', path: '/notes/:id', method: 'get', audience: 'public', input: idInput,
    contract: idContract, resolve: (ctx, input) => detail(ctx, input.id, false) }),
  mine: definePage({ id: 'notes.entry.mine', path: '/my-notes', method: 'get', audience: 'operator', input: listInput,
    contract: listContract, resolve: (ctx, input) => list(ctx, true, input.offset) }),
  new: definePage({ id: 'notes.entry.new', path: '/my-notes/new', method: 'get', audience: 'operator', input: z.object({}),
    contract: emptyContract, resolve: async (): Promise<PageOutcome<EditorView>> => ({ kind: 'view', view: { note: null, operationId: randomUUID() } }) }),
  edit: definePage({ id: 'notes.entry.edit', path: '/my-notes/:id', method: 'get', audience: 'operator', input: idInput,
    contract: idContract, resolve: (ctx, input) => detail(ctx, input.id, true) }),
  create: definePage({ id: 'notes.entry.create', path: '/my-notes', method: 'post', audience: 'operator', required: false, input: z.object({ ...operation, ...contentForm }),
    contract: { kind: 'storefront', request: 'form', input: { type: 'object', properties: { ...operationProperties, ...contentProperties }, required: ['operationId', 'title', 'body'], additionalProperties: false }, responses: writes },
    loginNext: () => '/my-notes/new', resolve: (ctx, { operationId, ...input }) => write(ctx, 'notes.entry.create', operationId, input) }),
  update: definePage({ id: 'notes.entry.update', path: '/my-notes/:id', method: 'post', audience: 'operator', required: false, input: z.object({ ...changeForm, ...contentForm }),
    contract: { kind: 'storefront', request: 'form', params: { id: 'id' }, input: { type: 'object', properties: { ...changeProperties, ...contentProperties }, required: ['id', 'revision', 'operationId', 'title', 'body'], additionalProperties: false }, responses: writes },
    loginNext: () => '/my-notes', resolve: (ctx, { operationId, ...input }) => write(ctx, 'notes.entry.update', operationId, input) }),
  publish: definePage({ id: 'notes.entry.publish', path: '/my-notes/:id/publish', method: 'post', audience: 'operator', required: false, input: z.object(changeForm),
    contract: { kind: 'storefront', request: 'form', params: { id: 'id' }, input: { type: 'object', properties: changeProperties, required: ['id', 'revision', 'operationId'], additionalProperties: false }, responses: writes },
    loginNext: () => '/my-notes', resolve: (ctx, { operationId, ...input }) => write(ctx, 'notes.entry.publish', operationId, input) }),
  unpublish: definePage({ id: 'notes.entry.unpublish', path: '/my-notes/:id/unpublish', method: 'post', audience: 'operator', required: false, input: z.object(changeForm),
    contract: { kind: 'storefront', request: 'form', params: { id: 'id' }, input: { type: 'object', properties: changeProperties, required: ['id', 'revision', 'operationId'], additionalProperties: false }, responses: writes },
    loginNext: () => '/my-notes', resolve: (ctx, { operationId, ...input }) => write(ctx, 'notes.entry.unpublish', operationId, input) }),
} as const;
