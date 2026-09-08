import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, renameSync, writeFileSync, constants, createReadStream, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { catalogDigest } from '@storeweave/db';
import { validateReleaseDirectory } from './release-validation';

const text = z.string().min(1).refine(value => !value.includes('\0'));
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decimal = z.string().regex(/^\d+$/);
const artifact = z.object({ directory: text.refine(isAbsolute), releaseId: z.enum(['base', 'commerce']), version: text,
  name: z.enum(['storeweave', 'commerce']), manifestChecksum: checksum, treeChecksum: checksum }).strict();
export const pairedSnapshotSchema = z.object({ schemaVersion: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime(),
  source: artifact, candidate: artifact, endpointChecksum: checksum,
  evidence: z.object({ database: z.object({ name: text, oid: decimal, systemIdentifier: decimal, serverVersion: text,
    properties: z.object({ owner: text, encoding: text, localeProvider: text, locale: z.string().nullable(), icuRules: z.string().nullable(),
      collate: text, ctype: text, tablespace: text, connectionLimit: z.number().int().min(-1), comment: z.string().nullable(),
      acl: z.array(z.object({ grantor: text, grantee: text.nullable(), privilege: z.enum(['CREATE', 'CONNECT', 'TEMPORARY']), grantable: z.boolean() }).strict()),
      settings: z.array(z.object({ role: text.nullable(), values: z.array(text) }).strict()),
    }).strict(),
  }).strict(), release: z.object({ sequence: decimal, checksum, releaseId: z.enum(['base', 'commerce']), releaseVersion: text, buildManifestChecksum: checksum }).strict(),
    migrationsChecksum: checksum, historyChecksum: checksum,
    historySequence: z.object({ lastValue: decimal, isCalled: z.boolean() }).strict(),
  }).strict(),
  dump: z.object({ file: z.literal('database.dump'), bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();

/** expectedChecksum must come from the selected transition journal, never from this descriptor itself. */
export async function readPairedSnapshot(directory: string, expectedChecksum: string) {
  checksum.parse(expectedChecksum);
  directory = resolve(directory);
  const raw = readPrivateJson(join(directory, 'snapshot.json'));
  if (catalogDigest(raw) !== expectedChecksum) throw new Error('Snapshot descriptor checksum mismatch');
  const manifest = pairedSnapshotSchema.parse(raw);
  if (basename(directory) !== manifest.id || manifest.source.releaseId !== manifest.candidate.releaseId
    || manifest.evidence.release.releaseId !== manifest.source.releaseId
    || manifest.evidence.release.releaseVersion !== manifest.source.version
    || manifest.evidence.release.buildManifestChecksum !== manifest.source.manifestChecksum) throw new Error('Snapshot identity mismatch');
  for (const saved of [manifest.source, manifest.candidate]) {
    if (catalogDigest(validateReleaseDirectory(saved.directory, saved.releaseId)) !== catalogDigest(saved)) throw new Error('Snapshot release artifact changed');
  }
  const dump = join(directory, manifest.dump.file);
  await verifyPrivateDump(dump, manifest.dump);
  return { directory, manifest, manifestChecksum: expectedChecksum, dump };
}

function openPrivate(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('Snapshot file must be a private regular file without extra links');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}


/** Shared private metadata reader for snapshot descriptors and their transition journals. */
export function readPrivateJson(file: string): unknown {
  const root = lstatSync(dirname(file));
  if (!root.isDirectory() || (root.mode & 0o077)) throw new Error('Metadata directory must be private');
  const metadata = openPrivate(file);
  let raw: unknown;
  try {
    const size = fstatSync(metadata).size;
    if (size > 1024 * 1024) throw new Error('Snapshot descriptor exceeds 1 MiB');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(metadata, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== size) throw new Error('Snapshot descriptor changed while reading');
    raw = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { closeSync(metadata); }
  return raw;
}

/** Caller holds the transition lock; replacement is durable before returning. */
export function writePrivateJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  for (const path of [dirname(file), dirname(dirname(file))]) {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}


/** Journals must remain direct UUID children of the locked, owned operation root. */
export function assertJournalLocation(file: string, operationRoot: string) {
  const root = resolve(operationRoot), home = dirname(resolve(file));
  if (dirname(home) !== root) throw new Error('Journal is outside the locked transition root');
  for (const directory of [root, home]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Journal directory must be owned and 0700');
  }
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600)) throw new Error('Journal file must be owned and 0600');
}

export async function verifyPrivateDump(dump: string, expected: { bytes: number; checksum: string }) {
  const fd = openPrivate(dump);
  try {
    const before = fstatSync(fd);
    if (before.size !== expected.bytes) throw new Error('Snapshot dump size mismatch');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(dump, { fd, autoClose: false })) {
      bytes += chunk.length;
      if (bytes > expected.bytes) throw new Error('Snapshot dump changed while reading');
      hash.update(chunk);
    }
    const after = fstatSync(fd);
    if (bytes !== expected.bytes || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || hash.digest('hex') !== expected.checksum) throw new Error('Snapshot dump checksum mismatch');
  } finally { closeSync(fd); }
}
