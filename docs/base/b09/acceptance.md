# B09 acceptance

- [x] Postgres metadata migration, lifecycle state, namespace isolation, list/delete operations
- [x] Streamed local adapter with temporary-file cleanup, SHA-256, size limit, regular-file/symlink checks
- [x] Private S3-compatible adapter with temporary object promotion
- [x] S3-compatible adapter exercised against MinIO, including abandoned temporary objects and multipart abort
- [x] Multipart upload plus binary download HTTP contract; no byte stream is routed through Command/Query Bus
- [x] Private/public policy, signed B12 download token, role permissions, and safe response headers
- [x] Generated deployment schemas and persistent-storage operations guidance
- [x] Local security and storage lifecycle integration regression tests
## Deployment preflight (after a provider is selected)

The repository intentionally has no production S3 endpoint, bucket, or credentials. Before a deployment selects
`storage.driver: s3`, an operator must run the same upload/download/delete and interrupted-upload smoke check
against that provider using secret references only. This is a rollout preflight, not an unimplemented B09 feature.

## Rollback

The migration and storage roots are additive. Rolling back application code disables the routes but must not remove
`platform_storage_objects`, the local storage root, S3 prefix, or signing keys used by unexpired links. A local/S3
transition is a data migration: copy and verify every object id, size, and SHA-256 before changing configuration.
