import { describe, expect, it } from 'vitest';
import { runModuleContractChecks } from '@storeweave/release/module-contract';
import { buildReleaseManifest } from '@storeweave/release/runtime';
import { release } from '../src/runtime';
import { notesReleaseDefinition, validateNotesReleaseDefinition } from '../src/definition';
import { createNoteInput, updateNoteInput } from '../src/types';

describe('Notes teaching release', () => {
  it('satisfies the module contract with its own routes and renderers', () => {
    expect(runModuleContractChecks(release, 'notes').filter(check => !check.ok)).toEqual([]);
    const names = buildReleaseManifest(release).modules.map(module => module.id);
    expect(names).toContain('notes');
    expect(names).not.toContain('content');
    expect(names).not.toContain('order');
  });
  it('rejects a different release selection', () => {
    expect(() => validateNotesReleaseDefinition({ ...notesReleaseDefinition, manifest: {
      ...notesReleaseDefinition.manifest, selected: { ...notesReleaseDefinition.manifest.selected, modules: ['content'] },
    } })).toThrow();
  });
  it('rejects client ownership, blank content and incomplete updates', () => {
    expect(createNoteInput.safeParse({ title: 'Hello', body: 'Body', ownerActorId: 'someone-else' }).success).toBe(false);
    expect(createNoteInput.safeParse({ title: '  ', body: 'Body' }).success).toBe(false);
    expect(updateNoteInput.safeParse({ id: 'f42f207f-69ec-434d-9fa1-5556cccfc110', title: 'Hello', body: 'Body' }).success).toBe(false);
  });
});
