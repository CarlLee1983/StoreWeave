import { sqlMigration,type MigrationSet } from '@storeweave/db';
export const contentMigrations:MigrationSet={module:'content',migrations:[sqlMigration('0001_init','expand',`
CREATE TABLE IF NOT EXISTS content_articles (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('story','journal','news','faq')), slug text NOT NULL,
 title text NOT NULL, summary text NOT NULL DEFAULT '', section text NOT NULL DEFAULT '',
 body jsonb NOT NULL DEFAULT '[]'::jsonb, image_key text, position integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
 published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (jsonb_typeof(body) = 'array'), CHECK ((status = 'published') = (published_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS content_articles_kind_slug_idx ON content_articles (kind, slug);
CREATE INDEX IF NOT EXISTS content_articles_listing_idx ON content_articles (kind, status, position, published_at DESC);
CREATE TABLE IF NOT EXISTS content_contact_messages (
 id uuid PRIMARY KEY, customer_id uuid, name text NOT NULL, email text NOT NULL, subject text NOT NULL, message text NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','handled')),
 handled_by_actor_id text, handled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status = 'handled') = (handled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS content_contact_messages_inbox_idx ON content_contact_messages (status, created_at DESC);
`),sqlMigration('0002_media_expand','expand',`
ALTER TABLE public.content_articles ADD COLUMN IF NOT EXISTS media_asset_id uuid;
CREATE INDEX IF NOT EXISTS content_articles_media_asset_idx ON public.content_articles (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.content_legacy_media_mappings (
 theme_id text NOT NULL, image_key text NOT NULL, source_digest text NOT NULL,
 media_asset_id uuid, status text NOT NULL CHECK (status IN ('pending','ready','failed')),
 error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (theme_id, image_key, source_digest),
 CHECK (status <> 'ready' OR media_asset_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS content_legacy_media_mappings_pending_idx
 ON public.content_legacy_media_mappings (status, updated_at) WHERE status <> 'ready';
`)]};
