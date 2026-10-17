import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { defineCommand, PlatformError, type CommandContext } from '@storeweave/contracts';
import { NotesRepository } from './repository';
import { changeNoteInput, createNoteInput, noteDto, updateNoteInput, type Note } from './types';

const repository = new NotesRepository();
const commandOptions = { permission: 'notes:write', idempotency: 'required', idempotencyScope: 'actor' } as const;

export const createNote = defineCommand({
  name: 'notes.entry.create', input: createNoteInput, output: noteDto, ...commandOptions,
  audit: { action: 'notes.created', resourceType: 'note', resourceId: (_i, o) => o.id, redact: () => ({}) },
});
export async function createNoteHandler(input: z.infer<typeof createNoteInput>, ctx: CommandContext) {
  return repository.insert(ctx.tx, { ...input, id: randomUUID(), ownerActorId: ctx.actor.id,
    status: 'draft', revision: 1, createdAt: ctx.now, updatedAt: ctx.now });
}

export const updateNote = defineCommand({
  name: 'notes.entry.update', input: updateNoteInput, output: noteDto, ...commandOptions,
  audit: { action: 'notes.updated', resourceType: 'note', resourceId: i => i.id, redact: () => ({}) },
});
export const publishNote = defineCommand({
  name: 'notes.entry.publish', input: changeNoteInput, output: noteDto, ...commandOptions,
  audit: { action: 'notes.published', resourceType: 'note', resourceId: i => i.id },
});
export const unpublishNote = defineCommand({
  name: 'notes.entry.unpublish', input: changeNoteInput, output: noteDto, ...commandOptions,
  audit: { action: 'notes.unpublished', resourceType: 'note', resourceId: i => i.id },
});

async function change(input: z.infer<typeof changeNoteInput>, ctx: CommandContext, from: Note['status'], patch: Partial<Pick<Note, 'title' | 'body' | 'status'>>) {
  const result = await repository.change(ctx.tx, input.id, ctx.actor.id, input.revision, from, patch, ctx.now);
  if (result) return result;
  // Do not disclose another author's private note, even to a role with wildcard permissions.
  if (!await repository.owned(ctx.tx, input.id, ctx.actor.id)) throw PlatformError.notFound('Note', input.id);
  throw PlatformError.conflict('筆記已被更新，或目前狀態不允許此操作。請重新開啟筆記後再試。');
}
export const updateNoteHandler = (input: z.infer<typeof updateNoteInput>, ctx: CommandContext) =>
  change(input, ctx, 'draft', { title: input.title, body: input.body });
export const publishNoteHandler = (input: z.infer<typeof changeNoteInput>, ctx: CommandContext) =>
  change(input, ctx, 'draft', { status: 'published' });
export const unpublishNoteHandler = (input: z.infer<typeof changeNoteInput>, ctx: CommandContext) =>
  change(input, ctx, 'published', { status: 'draft' });
