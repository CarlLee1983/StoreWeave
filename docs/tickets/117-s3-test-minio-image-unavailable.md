# 117 — S3 integration test MinIO image unavailable

GitHub tracker: #103.

**Problem:** CI cannot start `tests/integration/storage-s3.test.ts` because the pinned
`quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z` image is no longer available to
anonymous pulls. This blocks integration shard 1 and its summary check on unrelated PRs.

**Scope:** Change only the test container image source. Keep the same MinIO image
content and all four S3 behavior assertions.

## Acceptance

- [x] Pin the replacement image by the original multi-architecture digest, with
      anonymous registry access on both amd64 and arm64.
- [ ] `tests/integration/storage-s3.test.ts` passes after pulling from the new source.
- [ ] `make verify` passes.

## Evidence

- PR #96 CI runs 36004060284 and 36006276315: integration shard 1 fails before
  S3 test cases run with Docker `unauthorized: access to the requested resource is
  not authorized`; 56 other files pass in the latter run.
- `docker manifest inspect quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z`
  returns `no such manifest` without using the locally cached image.
- `docker manifest inspect ghcr.io/l33tlamer/minio-backup@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e`
  returns the original digest with arm64 and amd64 manifests.
