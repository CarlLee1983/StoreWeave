import type { z } from 'zod';
import { defineQuery, PlatformError, type QueryContext } from '@storeweave/contracts';
import { NotesRepository } from './repository';
import { listNotesInput, noteDto, noteIdInput, notesListDto } from './types';

const repository = new NotesRepository();
export const listMine = defineQuery({ name: 'notes.entry.listMine', input: listNotesInput, output: notesListDto, permission: 'notes:write' });
export const getMine = defineQuery({ name: 'notes.entry.getMine', input: noteIdInput, output: noteDto, permission: 'notes:write' });
export const listPublished = defineQuery({ name: 'notes.entry.listPublished', input: listNotesInput, output: notesListDto, permission: 'notes:public-read' });
export const getPublished = defineQuery({ name: 'notes.entry.getPublished', input: noteIdInput, output: noteDto, permission: 'notes:public-read' });
export const listMineHandler = (input: z.infer<typeof listNotesInput>, ctx: QueryContext) => repository.list(ctx.db, input.offset, ctx.actor.id);
export const listPublishedHandler = (input: z.infer<typeof listNotesInput>, ctx: QueryContext) => repository.list(ctx.db, input.offset);
export async function getMineHandler(input: z.infer<typeof noteIdInput>, ctx: QueryContext) {
  const note = await repository.owned(ctx.db, input.id, ctx.actor.id);
  if (!note) throw PlatformError.notFound('Note', input.id);
  return note;
}
export async function getPublishedHandler(input: z.infer<typeof noteIdInput>, ctx: QueryContext) {
  const note = await repository.published(ctx.db, input.id);
  if (!note) throw PlatformError.notFound('Note', input.id);
  return note;
}
