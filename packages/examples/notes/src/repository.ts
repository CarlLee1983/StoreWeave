import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb, Tx } from '@storeweave/contracts';
import { notes } from './schema';
import { NOTES_PAGE_SIZE, type Note, type NotesList } from './types';

export function toNote(row: typeof notes.$inferSelect): Note {
  const { ownerActorId: _owner, ...note } = row;
  return note;
}

export class NotesRepository {
  async insert(tx: Tx, row: typeof notes.$inferInsert): Promise<Note> {
    const [saved] = await tx.insert(notes).values(row).returning();
    return toNote(saved!);
  }

  async owned(db: DrizzleDb | Tx, id: string, owner: string): Promise<Note | undefined> {
    const [row] = await db.select().from(notes).where(and(eq(notes.id, id), eq(notes.ownerActorId, owner)));
    return row && toNote(row);
  }

  async published(db: DrizzleDb, id: string): Promise<Note | undefined> {
    const [row] = await db.select().from(notes).where(and(eq(notes.id, id), eq(notes.status, 'published')));
    return row && toNote(row);
  }

  async list(db: DrizzleDb, offset: number, owner?: string): Promise<NotesList> {
    const rows = await db.select().from(notes)
      .where(owner === undefined ? eq(notes.status, 'published') : eq(notes.ownerActorId, owner))
      .orderBy(desc(notes.updatedAt), desc(notes.id)).limit(NOTES_PAGE_SIZE + 1).offset(offset);
    return { items: rows.slice(0, NOTES_PAGE_SIZE).map(toNote), hasMore: rows.length > NOTES_PAGE_SIZE };
  }

  // Ownership, revision and state are checked by the same UPDATE, not only by a preceding read.
  async change(tx: Tx, id: string, owner: string, revision: number, status: Note['status'], patch: Partial<Pick<Note, 'title' | 'body' | 'status'>>, now: Date) {
    const [row] = await tx.update(notes).set({ ...patch, revision: revision + 1, updatedAt: now })
      .where(and(eq(notes.id, id), eq(notes.ownerActorId, owner), eq(notes.revision, revision), eq(notes.status, status))).returning();
    return row && toNote(row);
  }
}
