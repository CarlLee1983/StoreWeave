import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { PlatformError } from '@storeweave/contracts';
import type { Database } from '@storeweave/db';
import type { MediaAsset, MediaReferencesPort } from '@storeweave/media';

/** A release-owned, closed mapping. Callers must not derive paths from article data. */
export interface LegacyMediaManifestEntry {
  readonly themeId: string;
  readonly imageKey: string;
  readonly file: string;
  readonly altText: string;
  readonly sourceDigest: string;
}

export interface LegacyMediaSource {
  open(entry: LegacyMediaManifestEntry): Promise<{ stream: Readable; contentType: string }>;
}

export interface LegacyMediaService {
  upload(input: { stream: Readable; originalName: string; contentType: string; ownerActorId: string }): Promise<MediaAsset>;
  get(id: string): Promise<MediaAsset | undefined>;
  updateAltText(id: string, altText: string): Promise<MediaAsset>;
}

export interface LegacyMediaBackfillReport {
  readonly imported: number;
  readonly waiting: number;
  readonly attached: number;
  readonly failed: readonly { imageKey: string; error: string }[];
}

type MappingRow = { media_asset_id: string | null; status: 'pending' | 'ready' | 'failed'; error: string | null };
const BACKFILL_ACTOR = 'system:content-legacy-media-backfill';

/**
 * Explicit B14 data operation, intentionally separate from SQL migrations.
 * B10's worker owns image processing, so a first run normally imports and a
 * later run attaches only assets whose status has reached `ready`.
 */
export class LegacyContentMediaBackfill {
  constructor(
    private readonly database: Database,
    private readonly media: LegacyMediaService,
    private readonly references: MediaReferencesPort,
    private readonly source: LegacyMediaSource,
  ) {}

  async run(entries: readonly LegacyMediaManifestEntry[]): Promise<LegacyMediaBackfillReport> {
    let imported = 0;
    let waiting = 0;
    let attached = 0;
    const failed: { imageKey: string; error: string }[] = [];
    for (const entry of entries) {
      const result = await this.runEntry(entry);
      imported += result.imported;
      waiting += result.waiting;
      attached += result.attached;
      if (result.failed) failed.push({ imageKey: entry.imageKey, error: result.failed });
    }
    return { imported, waiting, attached, failed };
  }

  private async runEntry(entry: LegacyMediaManifestEntry): Promise<{ imported: number; waiting: number; attached: number; failed?: string }> {
    const mapping = await this.mapping(entry);
    if (!mapping?.media_asset_id) {
      try {
        const source = await this.source.open(entry);
        const chunks: Buffer[] = [];
        for await (const chunk of source.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== entry.sourceDigest) throw PlatformError.validation(`Legacy media digest mismatch for ${entry.imageKey}`);
        const asset = await this.media.upload({ stream: Readable.from([bytes]), originalName: entry.file, contentType: source.contentType, ownerActorId: BACKFILL_ACTOR });
        await this.media.updateAltText(asset.id, entry.altText);
        await this.saveMapping(entry, asset.id, 'pending', null);
        return { imported: 1, waiting: 1, attached: 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Legacy media import failed';
        await this.saveMapping(entry, null, 'failed', message);
        return { imported: 0, waiting: 0, attached: 0, failed: message };
      }
    }
    const asset = await this.media.get(mapping.media_asset_id);
    if (!asset || asset.status === 'failed' || asset.status === 'deleting') {
      const message = asset?.processingError ?? 'Imported media asset is unavailable';
      await this.saveMapping(entry, mapping.media_asset_id, 'failed', message);
      return { imported: 0, waiting: 0, attached: 0, failed: message };
    }
    if (asset.status !== 'ready') return { imported: 0, waiting: 1, attached: 0 };
    const count = await this.attachReadyMapping(entry, asset.id);
    await this.saveMapping(entry, asset.id, 'ready', null);
    return { imported: 0, waiting: 0, attached: count };
  }

  /** Contract gate: every legacy key is known, ready, attached, and referenced. */
  async reconcile(entries: readonly LegacyMediaManifestEntry[]): Promise<{ unmappedKeys: string[]; incompleteKeys: string[] }> {
    const known = new Set(entries.map(entry => entry.imageKey));
    const legacy = await this.database.pool.query<{ image_key: string }>('SELECT DISTINCT image_key FROM public.content_articles WHERE image_key IS NOT NULL');
    const unmappedKeys = legacy.rows.map(row => row.image_key).filter(key => !known.has(key));
    const incompleteKeys: string[] = [];
    for (const entry of entries) {
      const mapping = await this.mapping(entry);
      if (!mapping || mapping.status !== 'ready' || !mapping.media_asset_id) {
        const usage = await this.database.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM public.content_articles WHERE image_key = $1', [entry.imageKey]);
        if (Number(usage.rows[0]?.count ?? 0)) incompleteKeys.push(entry.imageKey);
        continue;
      }
      const mismatch = await this.database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.content_articles a
        WHERE a.image_key = $1 AND (a.media_asset_id IS DISTINCT FROM $2 OR NOT EXISTS (
          SELECT 1 FROM public.platform_media_references r WHERE r.media_asset_id = $2 AND r.owner_type = 'content.article' AND r.owner_id = a.id::text))`, [entry.imageKey, mapping.media_asset_id]);
      if (Number(mismatch.rows[0]?.count ?? 0)) incompleteKeys.push(entry.imageKey);
    }
    return { unmappedKeys, incompleteKeys };
  }

  private async mapping(entry: LegacyMediaManifestEntry): Promise<MappingRow | undefined> {
    const result = await this.database.pool.query<MappingRow>(`SELECT media_asset_id, status, error FROM public.content_legacy_media_mappings
      WHERE theme_id = $1 AND image_key = $2 AND source_digest = $3`, [entry.themeId, entry.imageKey, entry.sourceDigest]);
    return result.rows[0];
  }

  private async saveMapping(entry: LegacyMediaManifestEntry, mediaAssetId: string | null, status: MappingRow['status'], error: string | null): Promise<void> {
    await this.database.pool.query(`INSERT INTO public.content_legacy_media_mappings
      (theme_id, image_key, source_digest, media_asset_id, status, error)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (theme_id, image_key, source_digest) DO UPDATE
      SET media_asset_id = EXCLUDED.media_asset_id, status = EXCLUDED.status, error = EXCLUDED.error, updated_at = pg_catalog.clock_timestamp()`,
    [entry.themeId, entry.imageKey, entry.sourceDigest, mediaAssetId, status, error]);
  }

  private async attachReadyMapping(entry: LegacyMediaManifestEntry, mediaAssetId: string): Promise<number> {
    return this.database.transaction(async tx => {
      const articles = await tx.execute<{ id: string }>(sql`SELECT id FROM public.content_articles
        WHERE image_key = ${entry.imageKey} AND media_asset_id IS NULL FOR UPDATE`);
      for (const article of articles.rows) {
        await this.references.replace(tx, { ownerType: 'content.article', ownerId: article.id, mediaIds: [mediaAssetId] });
        await tx.execute(sql`UPDATE public.content_articles SET media_asset_id = ${mediaAssetId}, updated_at = pg_catalog.clock_timestamp() WHERE id = ${article.id}`);
      }
      return articles.rows.length;
    });
  }
}
