import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PlatformError, type Tx } from '@storeweave/contracts';
import type { Database, MigrationSet } from '@storeweave/db';
import { sqlMigration } from '@storeweave/db';
import type { JobContext, JobQueue } from '@storeweave/jobs';
import type { StorageObject, StorageScope } from '@storeweave/storage';

export const MEDIA_PROCESS_JOB = 'platform.media.process';
export const MEDIA_ORPHAN_CLEANUP_JOB = 'platform.media.cleanup-orphans';
export const MEDIA_NAMESPACE = 'platform-media';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 12_000;
const PREVIEW_WIDTH = 1_600;
const PROCESS_TIMEOUT_SECONDS = 30;
const ORPHAN_GRACE_MS = 60 * 60 * 1_000;
// Native Sharp must not load while the release manifest/API is composed. The
// worker is the sole image-processing consumer and loads it on first use.
type SharpFactory = typeof import('sharp');
let sharpLoader: Promise<{ default: SharpFactory }> | undefined;
async function loadSharp(): Promise<SharpFactory> {
  sharpLoader ??= import('sharp') as Promise<{ default: SharpFactory }>;
  return (await sharpLoader).default;
}

export const mediaMigrations: MigrationSet = {
  module: 'platform-media',
  migrations: [sqlMigration('0001_init', 'expand', `
CREATE TABLE IF NOT EXISTS public.platform_media_assets (
  id uuid PRIMARY KEY,
  original_object_id uuid NOT NULL UNIQUE,
  preview_object_id uuid UNIQUE,
  owner_actor_id text,
  alt_text text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'deleting')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  processing_token uuid,
  width integer,
  height integer,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (status <> 'ready' OR preview_object_id IS NOT NULL),
  CHECK (status <> 'ready' OR (width IS NOT NULL AND height IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS platform_media_assets_list_idx
  ON public.platform_media_assets (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS platform_media_assets_cleanup_idx
  ON public.platform_media_assets (status, updated_at) WHERE status IN ('failed', 'deleting');
CREATE TABLE IF NOT EXISTS public.platform_media_references (
  media_asset_id uuid NOT NULL REFERENCES public.platform_media_assets(id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type ~ '^[a-z][a-z0-9.-]{0,99}$'),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (media_asset_id, owner_type, owner_id)
);
CREATE INDEX IF NOT EXISTS platform_media_references_owner_idx
  ON public.platform_media_references (owner_type, owner_id);
`)],
};

export type MediaStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'deleting';
export interface MediaReferencesPort {
  replace(tx: Tx, input: { ownerType: string; ownerId: string; mediaIds: readonly string[] }): Promise<void>;
}
export interface MediaAsset {
  readonly id: string;
  readonly originalObjectId: string;
  readonly previewObjectId: string | null;
  readonly ownerActorId: string | null;
  readonly altText: string;
  readonly status: MediaStatus;
  readonly generation: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly processingError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type AssetRow = {
  id: string; original_object_id: string; preview_object_id: string | null; owner_actor_id: string | null;
  alt_text: string; status: MediaStatus; generation: number; width: number | null; height: number | null;
  processing_error: string | null; created_at: Date; updated_at: Date;
};

function toAsset(row: AssetRow): MediaAsset {
  return Object.freeze({
    id: row.id, originalObjectId: row.original_object_id, previewObjectId: row.preview_object_id,
    ownerActorId: row.owner_actor_id, altText: row.alt_text, status: row.status, generation: row.generation,
    width: row.width, height: row.height, processingError: row.processing_error,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
  });
}

function mediaError(_error: unknown): string { return 'Image processing failed'; }

function assertImageType(contentType: string): void {
  if (!ACCEPTED_TYPES.has(contentType.toLowerCase().split(';', 1)[0]!)) {
    throw PlatformError.validation('Media uploads must be JPEG, PNG, or WebP images');
  }
}

function expectedSharpFormat(contentType: string): 'jpeg' | 'png' | 'webp' {
  switch (contentType.toLowerCase().split(';', 1)[0]) {
    case 'image/jpeg': return 'jpeg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    default: throw PlatformError.validation('Media uploads must be JPEG, PNG, or WebP images');
  }
}

function assertAltText(value: string): void {
  if (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw PlatformError.validation('Invalid media alt text');
}

/**
 * The platform-owned media lifecycle. B09 owns bytes; this service owns media
 * identity, derived-object bounds, processing state, and reference protection.
 */
export class MediaService {
  constructor(
    private readonly database: Database,
    private readonly storage: StorageScope,
    private readonly jobs: JobQueue,
  ) {}

  async upload(input: { stream: Readable; originalName: string; contentType: string; ownerActorId: string }): Promise<MediaAsset> {
    assertImageType(input.contentType);
    const original = await this.storage.upload({
      stream: input.stream, originalName: input.originalName, contentType: input.contentType,
      visibility: 'private', ownerActorId: input.ownerActorId,
    });
    const id = randomUUID();
    try {
      return await this.database.transaction(async tx => {
        const { rows } = await tx.execute<AssetRow>(sql`
          INSERT INTO public.platform_media_assets (id, original_object_id, owner_actor_id, status)
          VALUES (${id}, ${original.id}, ${input.ownerActorId}, 'pending') RETURNING *
        `);
        await this.jobs.enqueue(tx, {
          type: MEDIA_PROCESS_JOB, payload: { assetId: id, generation: 1 }, dedupeKey: `media:process:${id}`,
          maxAttempts: 3,
        });
        return toAsset(rows[0]!);
      });
    } catch (error) {
      await this.storage.delete(original.id).catch(() => undefined);
      throw error;
    }
  }

  async get(id: string): Promise<MediaAsset | undefined> {
    const { rows } = await this.database.pool.query<AssetRow>('SELECT * FROM public.platform_media_assets WHERE id = $1', [id]);
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

  async list(options: { limit: number; offset: number }): Promise<{ items: readonly MediaAsset[]; total: number }> {
    const { rows } = await this.database.pool.query<AssetRow>(`SELECT * FROM public.platform_media_assets
      WHERE status <> 'deleting' ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`, [options.limit, options.offset]);
    const total = await this.database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.platform_media_assets WHERE status <> 'deleting'`);
    return { items: rows.map(toAsset), total: Number(total.rows[0]!.count) };
  }

  async updateAltText(id: string, altText: string): Promise<MediaAsset> {
    const trimmed = altText.trim();
    assertAltText(trimmed);
    const { rows } = await this.database.pool.query<AssetRow>(`UPDATE public.platform_media_assets
      SET alt_text = $2, updated_at = pg_catalog.clock_timestamp() WHERE id = $1 AND status <> 'deleting' RETURNING *`, [id, trimmed]);
    if (!rows[0]) throw PlatformError.notFound('Media asset', id);
    return toAsset(rows[0]);
  }

  async retry(id: string): Promise<MediaAsset> {
    return this.database.transaction(async tx => {
      const { rows } = await tx.execute<AssetRow>(sql`SELECT * FROM public.platform_media_assets WHERE id = ${id} FOR UPDATE`);
      const asset = rows[0];
      if (!asset || asset.status === 'deleting') throw PlatformError.notFound('Media asset', id);
      if (asset.status !== 'failed') throw PlatformError.conflict('Only failed media can be retried');
      const generation = asset.generation + 1;
      const updated = await tx.execute<AssetRow>(sql`UPDATE public.platform_media_assets
        SET status = 'pending', generation = ${generation}, processing_error = NULL,
            updated_at = pg_catalog.clock_timestamp() WHERE id = ${id} RETURNING *`);
      await this.jobs.enqueue(tx, {
        type: MEDIA_PROCESS_JOB, payload: { assetId: id, generation }, dedupeKey: `media:process:${id}`,
        replaceExisting: true, maxAttempts: 3,
      });
      return toAsset(updated.rows[0]!);
    });
  }

  async remove(id: string): Promise<void> {
    const objects = await this.database.transaction(async tx => {
      const { rows } = await tx.execute<AssetRow>(sql`SELECT * FROM public.platform_media_assets WHERE id = ${id} FOR UPDATE`);
      if (!rows[0]) return [] as string[];
      const references = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM public.platform_media_references WHERE media_asset_id = ${id}`);
      if (Number(references.rows[0]?.count ?? 0) > 0) throw PlatformError.conflict('Referenced media cannot be deleted');
      const marked = await tx.execute<AssetRow>(sql`UPDATE public.platform_media_assets SET status = 'deleting', updated_at = pg_catalog.clock_timestamp()
        WHERE id = ${id} RETURNING *`);
      return [marked.rows[0]!.original_object_id, marked.rows[0]!.preview_object_id].filter((value): value is string => Boolean(value));
    });
    try {
      await Promise.all(objects.map(objectId => this.storage.delete(objectId)));
      await this.database.pool.query(`DELETE FROM public.platform_media_assets WHERE id = $1 AND status = 'deleting'`, [id]);
    } catch (error) {
      // Keep the deletion intent visible and retryable. Calling it a processing failure
      // would make a later image retry read an original we may already have removed.
      await this.database.pool.query(`UPDATE public.platform_media_assets SET status = 'deleting', processing_error = $2,
        updated_at = pg_catalog.clock_timestamp() WHERE id = $1 AND status = 'deleting'`, [id, mediaError(error)]).catch(() => undefined);
      throw error;
    }
  }

  /** Reconciles interrupted deletion and the upload→database compensation window. */
  async cleanup(options: { olderThan?: Date; limit?: number } = {}): Promise<{ deleted: number }> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Media cleanup limit must be 1 to 1000');
    const olderThan = options.olderThan ?? new Date(Date.now() - ORPHAN_GRACE_MS);
    let deleted = 0;

    // First complete assets where the database transaction committed but a process
    // stopped between the deletion marker and storage removal.
    const deleting = await this.database.pool.query<AssetRow>(`SELECT * FROM public.platform_media_assets
      WHERE status = 'deleting' ORDER BY updated_at ASC LIMIT $1`, [limit]);
    for (const asset of deleting.rows) {
      try {
        await Promise.all([asset.original_object_id, asset.preview_object_id].filter((id): id is string => Boolean(id)).map(id => this.storage.delete(id)));
        const removed = await this.database.pool.query(`DELETE FROM public.platform_media_assets WHERE id = $1 AND status = 'deleting'`, [asset.id]);
        deleted += removed.rowCount ?? 0;
      } catch (error) {
        await this.database.pool.query(`UPDATE public.platform_media_assets SET processing_error = $2, updated_at = pg_catalog.clock_timestamp()
          WHERE id = $1 AND status = 'deleting'`, [asset.id, mediaError(error)]).catch(() => undefined);
      }
    }

    const known = await this.database.pool.query<{ id: string }>(`SELECT original_object_id AS id FROM public.platform_media_assets
      UNION SELECT preview_object_id AS id FROM public.platform_media_assets WHERE preview_object_id IS NOT NULL`);
    const knownIds = new Set(known.rows.map(row => row.id));
    let cursor: { createdAt: Date; id: string } | undefined;
    let inspected = 0;
    // List through bounded pages so an old compensation orphan is eventually reached
    // without bypassing B09's scoped storage interface.
    while (inspected < limit * 10) {
      const page = await this.storage.list({ limit: Math.min(100, limit * 10 - inspected), cursor });
      if (page.length === 0) break;
      for (const object of page) {
        inspected += 1;
        if (object.createdAt < olderThan && !knownIds.has(object.id)) {
          await this.storage.delete(object.id);
          deleted += 1;
          if (deleted >= limit) return { deleted };
        }
      }
      const last = page.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < 100) break;
    }
    return { deleted };
  }

  async openPreview(id: string): Promise<{ asset: MediaAsset; object: StorageObject; content: Readable }> {
    const asset = await this.get(id);
    if (!asset || asset.status !== 'ready' || !asset.previewObjectId) throw PlatformError.notFound('Media asset', id);
    const opened = await this.storage.open(asset.previewObjectId);
    return { asset, object: opened.object, content: opened.content.stream };
  }

  /** Future modules call this in their own transaction; no cross-module foreign key is introduced. */
  readonly references: MediaReferencesPort = {
    replace: async (tx: Tx, input: { ownerType: string; ownerId: string; mediaIds: readonly string[] }) => {
      if (!/^[a-z][a-z0-9.-]{0,99}$/.test(input.ownerType) || !input.ownerId || input.ownerId.length > 200) {
        throw PlatformError.validation('Invalid media reference owner');
      }
      const mediaIds = [...new Set(input.mediaIds)];
      if (mediaIds.length) {
        const found = await tx.execute<{ id: string }>(sql`SELECT id FROM public.platform_media_assets
          WHERE id IN (${sql.join([...mediaIds].sort().map(id => sql`${id}`), sql`, `)}) AND status = 'ready' FOR KEY SHARE`);
        if (found.rows.length !== mediaIds.length) throw PlatformError.validation('Media references require ready assets');
      }
      await tx.execute(sql`DELETE FROM public.platform_media_references WHERE owner_type = ${input.ownerType} AND owner_id = ${input.ownerId}`);
      for (const mediaId of mediaIds) await tx.execute(sql`INSERT INTO public.platform_media_references (media_asset_id, owner_type, owner_id)
        VALUES (${mediaId}, ${input.ownerType}, ${input.ownerId})`);
    },
  };

  async process(input: { assetId: string; generation: number }, ctx: Pick<JobContext, 'signal'>): Promise<void> {
    // A reclaimed job may find `processing` after its previous worker died. A
    // fresh execution token fences that predecessor: only the latest claimant
    // can publish a preview or failure state.
    const processingToken = randomUUID();
    const claimed = await this.database.pool.query<AssetRow>(`UPDATE public.platform_media_assets SET status = 'processing', processing_token = $3, processing_error = NULL,
      updated_at = pg_catalog.clock_timestamp() WHERE id = $1 AND generation = $2 AND status IN ('pending', 'processing') RETURNING *`, [input.assetId, input.generation, processingToken]);
    const row = claimed.rows[0];
    if (!row) return;
    const asset = toAsset(row);
    let preview: StorageObject | undefined;
    try {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Media processing aborted');
      const source = await this.storage.open(asset.originalObjectId);
      const chunks: Buffer[] = [];
      for await (const chunk of source.content.stream) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Media processing aborted');
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const sourceBytes = Buffer.concat(chunks);
      // `metadata()` consumes a Sharp stream. Keep inspection and rendering as
      // independent decoders over the bounded source buffer; sharing one pipeline
      // can otherwise leave the render waiting after metadata has completed.
      const sharp = await loadSharp();
      const metadata = await sharp(sourceBytes, {
        failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true, animated: false,
      }).timeout({ seconds: PROCESS_TIMEOUT_SECONDS }).metadata();
      if (metadata.format !== expectedSharpFormat(source.object.contentType)) throw new Error('Image bytes do not match declared media type');
      if (!metadata.width || !metadata.height || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
        throw new Error(`Image dimensions must not exceed ${MAX_DIMENSION}px`);
      }
      const rendered = await sharp(sourceBytes, {
        failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true, animated: false,
      }).timeout({ seconds: PROCESS_TIMEOUT_SECONDS }).rotate().resize({ width: PREVIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Media processing aborted');
      preview = await this.storage.upload({
        stream: Readable.from([rendered.data]), originalName: `${asset.id}.webp`, contentType: 'image/webp',
        visibility: 'private', ownerActorId: asset.ownerActorId ?? undefined,
      });
      if (ctx.signal.aborted) {
        await this.storage.delete(preview.id);
        throw ctx.signal.reason ?? new Error('Media processing aborted');
      }
      const updated = await this.database.pool.query<AssetRow>(`UPDATE public.platform_media_assets
        SET status = 'ready', preview_object_id = $3, processing_token = NULL, width = $4, height = $5, processing_error = NULL,
            updated_at = pg_catalog.clock_timestamp()
        WHERE id = $1 AND generation = $2 AND status = 'processing' AND processing_token = $6 RETURNING *`,
      [asset.id, asset.generation, preview.id, rendered.info.width, rendered.info.height, processingToken]);
      if (!updated.rows[0]) {
        await this.storage.delete(preview.id);
        return;
      }
      if (asset.previewObjectId && asset.previewObjectId !== preview.id) await this.storage.delete(asset.previewObjectId).catch(() => undefined);
    } catch (error) {
      if (preview) await this.storage.delete(preview.id).catch(() => undefined);
      await this.database.pool.query(`UPDATE public.platform_media_assets SET status = 'failed', processing_token = NULL, processing_error = $3,
        updated_at = pg_catalog.clock_timestamp() WHERE id = $1 AND generation = $2 AND status = 'processing' AND processing_token = $4`,
      [asset.id, asset.generation, mediaError(error), processingToken]).catch(() => undefined);
      throw error;
    }
  }
}

export const mediaProcessPayload = z.object({ assetId: z.string().uuid(), generation: z.number().int().positive() }).strict();
export const mediaOrphanCleanupPayload = z.object({
  bucket: z.number().int(),
  scheduledFor: z.string().datetime(),
}).strict();
