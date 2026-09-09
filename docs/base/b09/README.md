# B09 — Storage

`@storeweave/storage` keeps object metadata in PostgreSQL and bytes behind a small local or S3-compatible adapter.
Callers receive a namespace-fixed `StorageScope`; they cannot select filesystem paths, buckets, or object keys.

- Local is the default and writes under `<paths.dataDir>/storage` through a private temporary file and atomic rename.
- S3-compatible backends retain private objects; StoreWeave implements public/private policy itself.
- Uploads stream through a size limit and SHA-256 counter. Common concrete image/PDF MIME declarations are checked against magic bytes.
- Generic B09 endpoints are for operators/services only. Catalog and customer media ownership belongs to B10.

The HTTP surface is `/api/v1/storage/objects`. Private reads require `storage:read`; signed links require
`storage:share` and an active B12 signing key. Only `storage:publish` can make an object public.
