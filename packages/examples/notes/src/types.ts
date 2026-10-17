import { z } from 'zod';

export const noteFields = {
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(10000),
};
export const createNoteInput = z.object(noteFields).strict();
export const noteIdInput = z.object({ id: z.string().uuid() }).strict();
export const changeNoteInput = noteIdInput.extend({ revision: z.number().int().positive() }).strict();
export const updateNoteInput = changeNoteInput.extend(noteFields).strict();
export const listNotesInput = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
export const noteDto = z.object({
  id: z.string().uuid(), title: z.string(), body: z.string(),
  status: z.enum(['draft', 'published']), revision: z.number().int(),
  createdAt: z.date(), updatedAt: z.date(),
});
export type Note = z.infer<typeof noteDto>;
export const notesListDto = z.object({ items: z.array(noteDto), hasMore: z.boolean() });
export type NotesList = z.infer<typeof notesListDto>;
export const NOTES_PAGE_SIZE = 20;
