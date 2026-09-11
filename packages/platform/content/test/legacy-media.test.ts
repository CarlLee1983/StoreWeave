import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LegacyContentMediaBackfill } from '../src/legacy-media';

const bytes = Buffer.from('legacy image bytes');
const entry = {
  themeId: 'default', imageKey: 'story', file: 'story.png', altText: 'Story image',
  sourceDigest: createHash('sha256').update(bytes).digest('hex'),
};

function harness(mapping: { media_asset_id: string | null; status: 'pending' | 'ready' | 'failed'; error: string | null } | undefined) {
  const query = vi.fn(async (statement: string) => {
    if (statement.includes('SELECT media_asset_id')) return { rows: mapping ? [mapping] : [] };
    return { rows: [], rowCount: 1 };
  });
  const execute = vi.fn(async () => ({ rows: [{ id: 'article-1' }] }));
  const database = { pool: { query }, transaction: async (fn: (tx: { execute: typeof execute }) => Promise<number>) => fn({ execute }) };
  const media = {
    upload: vi.fn(async () => ({ id: 'media-1', status: 'pending' as const })),
    updateAltText: vi.fn(async () => ({ id: 'media-1', status: 'pending' as const })),
    get: vi.fn(async () => ({ id: 'media-1', status: 'ready' as const, processingError: null })),
  };
  const references = { replace: vi.fn(async () => undefined) };
  const source = { open: vi.fn(async () => ({ stream: Readable.from([bytes]), contentType: 'image/png' })) };
  return { operation: new LegacyContentMediaBackfill(database as never, media as never, references, source), media, references, source, query, execute };
}

describe('legacy content media backfill', () => {
  it('verifies bytes, records a pending upload, and asks a later run to attach it', async () => {
    const { operation, media, source, query } = harness(undefined);

    await expect(operation.run([entry])).resolves.toEqual({ imported: 1, waiting: 1, attached: 0, failed: [] });

    expect(source.open).toHaveBeenCalledWith(entry);
    expect(media.upload).toHaveBeenCalledWith(expect.objectContaining({ originalName: 'story.png', contentType: 'image/png' }));
    expect(media.updateAltText).toHaveBeenCalledWith('media-1', 'Story image');
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO public.content_legacy_media_mappings'), expect.arrayContaining(['pending']));
  });

  it('attaches only a ready mapped asset and adds the B10 ownership reference in the same transaction', async () => {
    const { operation, media, references, execute, query } = harness({ media_asset_id: 'media-1', status: 'pending', error: null });

    await expect(operation.run([entry])).resolves.toEqual({ imported: 0, waiting: 0, attached: 1, failed: [] });

    expect(media.upload).not.toHaveBeenCalled();
    expect(references.replace).toHaveBeenCalledWith(expect.anything(), { ownerType: 'content.article', ownerId: 'article-1', mediaIds: ['media-1'] });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO public.content_legacy_media_mappings'), expect.arrayContaining(['ready']));
  });

  it('blocks an altered source before it can create a media asset', async () => {
    const bad = { ...entry, sourceDigest: '0'.repeat(64) };
    const { operation, media, query } = harness(undefined);

    await expect(operation.run([bad])).resolves.toEqual({ imported: 0, waiting: 0, attached: 0, failed: [{ imageKey: 'story', error: 'Legacy media digest mismatch for story' }] });

    expect(media.upload).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO public.content_legacy_media_mappings'), expect.arrayContaining(['failed']));
  });
});
