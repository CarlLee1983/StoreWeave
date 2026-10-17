import { defineModule } from '@storeweave/kernel';
import packageJson from '../package.json';
import { notesMigrations } from './migrations';
import { notesPages } from './pages';
import { createNote, createNoteHandler, updateNote, updateNoteHandler, publishNote, publishNoteHandler, unpublishNote, unpublishNoteHandler } from './commands';
import { getMine, getMineHandler, getPublished, getPublishedHandler, listMine, listMineHandler, listPublished, listPublishedHandler } from './queries';

export function createNotesModule() {
  return defineModule({
    name: 'notes', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }] },
    data: { owns: ['notes_entries'] }, migrations: notesMigrations,
    permissions: [
      { key: 'notes:write', description: '管理自己的筆記', owner: 'notes' },
      { key: 'notes:public-read', description: '閱讀已發布筆記', owner: 'notes' },
    ],
    commands: [
      { descriptor: createNote, handler: createNoteHandler }, { descriptor: updateNote, handler: updateNoteHandler },
      { descriptor: publishNote, handler: publishNoteHandler }, { descriptor: unpublishNote, handler: unpublishNoteHandler },
    ],
    queries: [
      { descriptor: getMine, handler: getMineHandler }, { descriptor: listMine, handler: listMineHandler },
      { descriptor: getPublished, handler: getPublishedHandler }, { descriptor: listPublished, handler: listPublishedHandler },
    ],
    pages: notesPages,
  });
}
