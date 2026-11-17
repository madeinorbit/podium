# POD-6963: Shared user file storage — design

Status: stage 1 design, revised after the POD-6951 coordinator's review (approval delegated by
the operator); the decisions are recorded in section 4. Written 2026-11-17 on
`issue/6963-shared-user-file-storage`, cut from `integrate/6951-cloud-hosting` at
`0afe9e00e3`. Paths are relative to `apps/server/src` unless they start with `packages/`,
`apps/` or `docs/`. Nothing here is implemented.

Parent: POD-6954 (Multi-process server runtime), under POD-6951 (Multi-tenant cloud hosting).
Reads with: `docs/design/POD-6959-workspace-partition-design.md` (how a workspace reaches a
repository) and `docs/design/POD-6958-postgres-store-design.md` (branches
`issue/6959-workspace-partitioned-data-model` and `issue/6958-postgres-store-beside-sqlite`).

## 0. The design on one page

- **Hosted object storage is the primary target** (operator principle, 2026-11-16). The
  interface is shaped by what an S3-compatible object store can do: whole-object writes,
  ranged reads, conditional writes, no append, no rename, no write at an offset. Local disk is
  the special case behind the same interface.
- **One small byte interface, `BlobStore`, built for one workspace.** `put` (optionally
  conditional), `get` (with a byte range), `head`, `delete`, `list`, `copy`. A store handle is
  constructed for a workspace, the way POD-6959 builds a repository for one (its section 2.4,
  S3): callers pass keys relative to the workspace and cannot name another workspace's prefix.
- **Keys are relative paths under four roots.** `artifacts/…`, `pending-uploads/…`,
  `transcripts/…`. On local disk the `local` workspace maps a key to the same path under the
  state directory; on hosted the key lives at `<workspaceId>/<key>` in one bucket.
- **One transcript lake, in fixed-size parts, on both backends.** Each mirrored segment is
  stored as 1 MiB parts under an incarnation-numbered prefix. Only the open last part is
  rewritten as it grows; the cursor already kept in the database says how many bytes exist.
  No new table, no rename when a file identity changes. Part writes are conditional, so a
  stale writer in a fleet cannot replace newer bytes.
- **Self-hosted converts its lake once.** A blocking, resumable upgrade step splits each
  existing lake file into parts, one segment at a time, and removes a source file only after
  its parts are verified. Artifacts and uploads keep their paths and need no conversion.
- **Readers take a byte source, not a path.** The shared transcript slice and index readers in
  `packages/harness` open files by path today. They change to read through a small
  random-access source; the daemon keeps a file-backed one, the server gets the lake's.
- **Metadata leaves the file tree.** Pending uploads and staged CLI uploads keep their state
  in `meta.json` files today; on hosted that would make the bucket a second source of truth
  and force bucket listings. Both move to workspace tables. Bytes stay in the store.
- **`/files` streams through the server.** An HTML bundle's relative links, its sandbox header
  and the workspace check all depend on the server answering. Today's route reads a whole file
  (up to 100 MB) into memory; it streams instead.
- **The fleet needs no file locks.** Lake part writes are conditional and the lake cursor
  advances by compare-and-set; an upload's received bytes advance by a conditional update. The
  in-process lock map and per-machine single-flight stay as optimisations, not as the
  guarantee.

## 1. What exists today

| Area | Fact | Where |
|---|---|---|
| Transcript lake | `MirrorService` writes `<lakeDir>/<machine>/<nativeId>.jsonl` with raw `node:fs`: open in append mode, `truncate(offset)`, then append, no `fsync`. Invariant: lake size equals the cursor before every write | `packages/sync/src/mirror.ts:162`, `:531` |
| Lake incarnations | A replaced native file archives the current copy by `rename` to `<nativeId>.incarnation-<seq>.jsonl`, then re-pulls from zero. The first incarnation is sequence 1; a segment mirrored before file identities existed has no incarnation row until its next pull adopts it as sequence 1 | `packages/sync/src/mirror.ts:562`, `store/conversations/mirror.ts:268-279` |
| Lake state | Cursors are columns of `conversation_segments` (`mirrored_bytes`, `reported_bytes`, `indexed_bytes`); `conversation_segment_incarnations` keeps each incarnation's `mirrored_bytes` | `migrations/schema.ts:1392-1395`, `:1472` |
| Lake wiring | Lake dir is `<state>/transcripts`, set only when the lake is on; hosted runs with `PODIUM_TRANSCRIPT_LAKE=off` because there is no blob store ("deferred blob-store port" in the hosted deployment design) | `server.ts:774`, `:822` |
| Lake readers | `TranscriptLake.readWindow` builds a file chain of lake paths; `readIndexItems` feeds the search indexer from a path | `modules/memory/lake.ts:203`, `:267` |
| Shared readers | `readFileItems`, `readFileWindowed`, `readIndexWindow` and the parsed-slice cache open and `stat` files by path; the daemon's live `transcriptRead` uses the same code | `packages/harness/src/store/slice.ts:33`, `:158`, `:405`, `:692` |
| Other lake-path readers | Two server tests write archived lake files by path. No tool or script reads lake files. `docs/spec/transcript-mirror.md` 2.1 documents the file layout | `modules/memory/lake.test.ts:309`, `relay.lake-read.test.ts:201` |
| Shared `transcripts/` name | On a co-located install the daemon uses `<state>/transcripts` as a grok transcript root, beside the server's lake | `apps/daemon/src/control/transcripts.ts:115`, `apps/daemon/src/host-runtime.ts:692` |
| Artifacts | `IssueArtifactStore` writes `<state>/artifacts/<issue>/<artifact>/<relpath>`; immutable per artifact id. Pulled from the daemon in 4 MB chunks, written whole | `modules/issues/artifact-store.ts`, `relay.ts:2464` |
| CLI bundle uploads | 512 KB packets written at offsets into `<state>/artifacts/.uploads/<issue>/<upload>/files/…` with `r+`, state in `meta.json`, serialised by an in-process lock map; publish is a `rename`. Caps: 100 MB a file, 500 MB a bundle, 200 files | `artifact-store.ts:154`, `:168`, `:333`; `packages/model/src/artifact-upload.ts:3-7` |
| Composer uploads | `PendingUploadStore`: `<state>/pending-uploads/<uuid>/meta.json` + `file/<name>`. A claim records the issue in `meta.json`, then the artifact store takes the dir by `rename` (`adopt`); a failed launch moves it back (`relinquish`). `claimedBy` lists the directory | `modules/issues/pending-uploads.ts:138`, `:197`; `artifact-store.ts:401`, `:430`; `modules/issues/service/crud.ts:915-981` |
| Sweeps | Hourly timer in the relay: pending uploads older than a day, staged CLI uploads older than a day (by directory mtime) | `relay.ts:691`, `:4953-4957`, `pending-uploads.ts:172`, `artifact-store.ts:357` |
| Serving | `GET /files/artifact/[workspace/<ws>/]<issue>/<artifact>/<rel>`; non-range reads load the whole file (`readFile`), ranges up to 10 MB; HTML gets a CSP sandbox; `immutable` cache. Authorisation is the `/files/*` client guard only | `file-artifact-route.ts:110-111`, `artifact-store.ts:628`, `raw-file-headers.ts`, `server.ts:1823-1825` |
| Hosted routing | The hosted router reads the workspace from a header, `?workspace=` or the `/files/artifact/workspace/<ws>/` path segment, before auth, so an artifact's relative sibling URLs stay in its workspace | hosted deployment `workspace-router.ts` |
| Transfer | `PortableStateFence` gates every writer during a server-transfer snapshot, in process; the snapshot walks every regular file under `transcripts`, `artifacts`, `uploads`, `pending-uploads` and hashes each; the daemon restores the same roots | `modules/server-transfer/portable-fence.ts`, `modules/server-transfer/snapshot.ts:21`, `apps/daemon/src/server-transfer.ts:50` |
| `uploads/` | The daemon's chat-attachment staging dir (`<state>/uploads/<session>/<id>.<ext>`); the server only validates refs into it | `modules/sessions/receipt-send.ts:130-140` |
| Handoff | `<state>/handoff/<token>-<ms>.tgz` is a stage file that lives for one call and is removed in `finally` | `modules/sessions/handoff-transfer.ts:121` |
| Hosted object storage | The hosted deployment already writes a daily state archive to an R2 bucket with a SigV4 `curl` | hosted deployment `docker/state-archive.sh` |
| Runtime | Bun 1.4.4 (`mise.toml`), which ships a built-in S3 client (`Bun.S3Client`) | `mise.toml:27` |

Two facts shape everything below. First, the lake's write primitive (truncate then append at
the cursor) has no object-store equivalent: S3-compatible stores replace whole objects.
Second, four flows rely on `rename` being cheap and atomic (CLI publish, adopt, relinquish,
lake archive); on an object store a rename is a copy plus a delete, and neither is atomic with
the other.

## 2. Decisions

### 2.1 The interface

**Options.**

- **I1. One filesystem-like interface** (open, write at offset, append, rename, readdir) with
  an object-store emulation underneath. Every caller keeps its shape; the emulation has to
  fake append and rename (copy whole objects, or keep a block map), and hides the cost.
- **I2. A plain object interface** (whole-object put, ranged get, head, delete, list, copy),
  and each owner adapts its algorithm to it.

**Tradeoffs.** I1 is the least change at the call sites and the worst on hosted: every lake
chunk would become a read-modify-write of an ever larger object or a hidden block index, and
what is atomic or survives a crash would differ by backend while looking the same. I2 is
honest about the object store; each owner's algorithm is written once and runs on both.

**Prior art.** Object-store-backed logs write immutable or whole-object segments and keep the
index elsewhere: Kafka tiered storage uploads closed segments; Litestream ships WAL segments as
separate objects. Append exists only as a provider extension (S3 Express One Zone, Azure
append blobs, Google Cloud Storage compose); R2, which hosted uses, has none.

**Decision: I2.**

```ts
// packages/blob-store (new, no apps/* imports, so packages/sync can depend on it)
export interface BlobStore {
  put(key: BlobKey, body: Uint8Array | ReadableStream, opts?: {
    contentType?: string
    ifAbsent?: true          // refuse when the key exists (S3 If-None-Match: *)
    ifMatch?: string         // refuse unless the stored etag equals this (S3 If-Match)
    durable?: boolean        // local disk only: fsync file and directory (default true)
  }): Promise<{ etag: string; size: number }>  // a refused condition throws BlobConditionFailed
  get(key: BlobKey, range?: { offset: number; length: number }):
    Promise<{ body: ReadableStream<Uint8Array>; size: number; etag: string } | undefined>
  head(key: BlobKey): Promise<{ size: number; etag: string } | undefined>
  delete(key: BlobKey): Promise<void>                       // idempotent
  list(prefix: BlobKey): AsyncIterable<{ key: BlobKey; size: number }>
  copy(from: BlobKey, to: BlobKey): Promise<void>           // server-side on S3; a file copy on disk
  readonly conditionalWrites: boolean                       // the adapter honours ifAbsent and ifMatch
}
export interface BlobStorage {
  forWorkspace(workspaceId: WorkspaceId): BlobStore
}
```

- **Keys.** `BlobKey` is a branded relative path. One validator mints it: segments of
  `[A-Za-z0-9._-]`, no empty, `.` or `..` segment, no leading `/`. Callers build keys through
  small per-owner functions (`artifactKey(issue, artifact, rel)`), never by string joins. An
  id that is not already a valid segment (a native id with other characters) is encoded as
  `~` followed by the base32 form of its UTF-8 bytes (RFC 4648 alphabet, lower case, no
  padding); `~` is outside the segment alphabet, so an encoded id can never equal a plain one.
  Base32 has one case, so two encoded ids never collide on a case-insensitive filesystem
  (macOS and Windows desktop installs); the longest encodable id is 158 UTF-8 bytes, which fits
  the 255-byte segment limit. Plain ids keep today's paths and today's case behaviour. Numbers
  in keys (part numbers, chunk offsets) are zero-padded to a fixed width so lexicographic order
  is numeric order.
- **`get`.** A missing key returns `undefined`. A range is clipped to the object: an `offset`
  at or past the end returns an empty body with the object's real `size` (the S3 adapter maps
  the provider's 416 to this), and a range that runs past the end returns the bytes up to it.
  `size` is always the whole object's size.
- **`list`.** Ascending lexicographic order of key bytes, which is what S3's `ListObjectsV2`
  returns; the local adapter sorts. Sweeps and the orphan audit rely on it. It is for sweeps,
  audits and conversion checks only; no request path lists.
- **Atomic replace.** `put` is atomic from a reader's point of view on both backends: an object
  store replaces whole objects; the local adapter writes a temp file in the target directory
  and renames it over the key, so a reader sees the old bytes or the new ones, never a mix.
  `durable` (default true) adds `fsync` of the file before the rename and of the directory
  after it. The S3 adapter ignores it: an acknowledged PUT is durable.
- **Conditional writes.** The in-memory and local adapters support `ifAbsent` and `ifMatch`,
  so tests cover them. The local adapter's etag is the file's inode, size and modification
  time; a replace always makes a new inode, so every put changes it. It checks and renames
  under a per-key in-process mutex, so it assumes one server process per state directory, as
  the in-process transfer fence and sweeps already do. The S3 adapter sets
  `conditionalWrites` from what the provider honours (F2 verifies R2).
- **No `rename`.** Owners that move bytes today stop moving them, or copy (2.4, 2.5); the lake
  never needs to (2.3).
- **Construction.** `forWorkspace` is called where the workspace's service graph is built
  (POD-6959 section 2.8: one graph per workspace). A store handle cannot be re-pointed.
- **Temp files.** The local adapter names temp files `.tmp-<uuid>` beside the target and
  deletes leftovers at boot, so a crash never leaves them in a transfer snapshot.

### 2.2 Layout and workspace isolation

**Options.**

- **B1. One bucket, a prefix per workspace** (`<workspaceId>/<key>`).
- **B2. A bucket per workspace.**
- **B3. B1 with a per-workspace encryption key** (customer-provided keys or envelope
  encryption in the server).

**Tradeoffs.** B1 is one credential, one lifecycle policy, one place to audit; isolation
rests on the server never building a foreign key, which the per-workspace handle makes
structural. B2 gives a second, provider-enforced wall, but bucket counts are capped per
account, provisioning becomes part of workspace creation (POD-6964), and the server still
holds a credential that can reach every bucket. B3 adds cryptographic separation and makes
deleting a workspace a key deletion, at the cost of key custody and of range reads on
encrypted data.

**Prior art.** Multi-tenant SaaS on S3 commonly uses prefix-per-tenant in a shared bucket
with access enforced in the application, moving to bucket-per-tenant only for contractual
isolation.

**Decision: B1.** Encryption at rest is the provider's default (R2 encrypts every object).
Per-workspace keys are POD-6966's decision; the lake's fixed-size parts keep that option open,
because each part can be encrypted as a unit and still be range-read.

The local adapter maps workspace `local` to the state directory and **refuses every other
workspace id**. A self-hosted install has one workspace, so a second id can only be a bug.
The object adapter accepts `local` too, so a self-hosted operator may point at a bucket (2.8).

| Owner | Key (relative to the workspace) | Local disk (`local`) | Object store |
|---|---|---|---|
| Artifact member | `artifacts/<issue>/<artifact>/<rel>` | `<state>/artifacts/…` (today's path) | `<ws>/artifacts/…` |
| CLI upload chunk | `artifacts/.uploads/<issue>/<upload>/<member>/<offset>` | `<state>/artifacts/.uploads/…` | `<ws>/artifacts/.uploads/…` |
| Composer upload | `pending-uploads/<uuid>/file/<name>` | `<state>/pending-uploads/…` (today's path) | `<ws>/pending-uploads/…` |
| Lake part | `transcripts/<machine>/<native>/<incarnation>/<part>` | `<state>/transcripts/…` (converted, 2.3.1) | `<ws>/transcripts/…` |

### 2.3 Transcripts: one parted lake

The lake's contract stays as it is (`docs/spec/transcript-mirror.md`): verbatim bytes,
resumable from the persisted cursor, lake write before cursor advance, a shrink re-pulls from
zero, a new file identity starts a new incarnation and keeps the old one readable.

**Options for the layout.**

- **T1. One object per segment, rewritten on every chunk.** Simple; write cost grows with the
  transcript (a 50 MB transcript rewrites 50 MB per 256 KB chunk).
- **T2. One object per mirror chunk, indexed in a new table.** No rewrites, but one object and
  one row per pull, many tiny objects for a slowly growing session, and a compaction job.
- **T3. Fixed-size parts.** Part `n` holds bytes `[n·P, (n+1)·P)`. Only the last, open part is
  rewritten as it grows; a full part is never written again. The part list needs no table:
  the cursor says how many parts exist.
- **T4. Keep the unflushed tail in Postgres** and flush full parts to the store. Cheapest
  writes, but transcript bytes in the database, a second read path and a flush job.

**Tradeoffs.** T3's cost per chunk is bounded by P, not by the transcript: with P = 1 MiB and
256 KB chunks a write moves at most 1 MiB. Readers locate bytes by arithmetic. T2 and T4 buy
cheaper writes with a new table or bytes in Postgres (expensive per GB on hosted) and a
compactor; neither is needed at the rates the paced mirror produces (one pull per dirty
segment per scan, at most 16 MB per machine per pass).

**Prior art.** T3 is the fixed-block layout of a block device or of HDFS blocks, with the open
block rewritten; Kafka tiered storage avoids the open block by uploading closed segments only.

**Decision: T3, on both backends, as one implementation.** `PartedLake` sits on a `BlobStore`.
`MirrorService` writes through it, and readers get its `ByteSource` (2.6). There is no
separate local lake: the local adapter is the whole difference between self-hosted and hosted.

- **Keys.** `transcripts/<machine>/<native>/<incarnation>/<part>`, the part number padded to 8
  digits. The incarnation is the active row's `sequence`, or 1 for a segment that has no
  incarnation row yet; the adoption path creates sequence 1 for exactly those bytes, so the
  key never changes.
- **Write.** `write(offset, bytes)` reads the open part's kept prefix `[partStart, offset)`
  with its etag, appends, and puts the part with `ifMatch` that etag (or `ifAbsent` for a new
  part); a write that crosses a part boundary completes that part and starts the next. Only
  then does the cursor advance.
- **Size.** Stored size is `openPart · P + head(openPart).size`, where the open part is the
  one the cursor points into. The existing "lake shorter than cursor" guard (`mirrorOne`)
  works unchanged on it. Readers are bounded by `min(cursor, stored size)`.
- **Shrink.** When the source shrinks, the lake deletes every part of the active incarnation
  (durably, on local disk) before it resets the cursor to zero, which today's order already
  is (truncate, then cursor). Within an incarnation a part therefore only ever grows by
  extending its own prefix, between resets that removed it first. That is what makes the
  relaxed durability below safe: a part that loses its last rewrite comes back shorter, never
  longer with other bytes.
- **Rotation.** A new file identity needs no move: the predecessor's parts already sit under
  its own sequence. Rotating advances the active sequence in the incarnation table and records
  the archived byte count, as today.
- **P.** A constant, 1 MiB, chosen for write cost. F10 measures write amplification and read
  latency against a real bucket and may move it before hosted turns the lake on.

**The fleet fence.** In a fleet, two processes can mirror the same segment while a daemon's
connection moves (POD-6961). Two rules close it:

1. Part writes are conditional whenever the adapter supports it (`conditionalWrites`): every
   rewrite of an open part names the etag it read. A stale writer's put fails, and it re-reads
   the cursor and starts over. The in-memory and local adapters support it, so tests prove it.
2. The cursor advance is a compare-and-set
   (`UPDATE … SET mirrored_bytes = :new WHERE mirrored_bytes = :old`). A writer that loses
   re-reads the cursor.

On an adapter without conditional writes, rule 2 and the shorter-than-cursor guard remain; F2
records whether R2 needs that fallback.

**Consequences on local disk.**

- *Write cost.* Each pull rewrites at most one open part: a temp file of at most 1 MiB and a
  rename, where today appends only the new bytes. A cold bootstrap writes each part up to four
  times (256 KB chunks into a 1 MiB part), about 2.5 times the transcript's bytes; steady state
  is one rewrite of at most 1 MiB per pull per dirty segment, every scan at most. Reading the
  kept prefix is a read of a page-cached file. The pacing (25 ms after each chunk, 16 MB per
  pass) is unchanged and still dominates.
- *fsync.* Open-part rewrites use `durable: false`; today's appends never `fsync` either. A
  crash can lose the last rewrite; the part then comes back shorter (or missing), the guard
  sees stored size below the cursor, resets the cursor to it and re-pulls, and the re-pull is
  byte-identical. A put that completes a part, the shrink delete, and every conversion write
  use `durable: true`, so a full part never comes back short. That is one `fsync` per MiB of
  transcript, not per chunk.
- *File count.* A segment becomes one file per MiB plus a directory per incarnation: a lake
  of 2 GB is about 2,000 more files than segments today.
- *Server transfer.* The snapshot walks the same `transcripts` root and finds parts instead
  of whole files; every part is a regular file at a safe relative path, the byte total is the
  same, and the daemon restores the root as it is. The fence still pauses the mirror before the
  snapshot; temp files cannot be in flight under the fence and leftovers are removed at boot.
- *The shared `transcripts/` name.* Nothing walks the root to find lake files: the lake and the
  conversion are driven by database rows, so a co-located daemon's own files under the same
  directory are never touched.

#### 2.3.1 Converting existing self-hosted lakes

A blocking upgrade step at boot, after the store migrations and before the mirror starts. It
prints one progress line per 100 segments and a summary. It takes as long as it takes.

1. **Work list from the database**: every `(machine, native)` with `mirrored_bytes > 0`, and
   every incarnation row with `mirrored_bytes > 0`, in key order. Each names one source file:
   the canonical `<machine>/<native>.jsonl` for the active incarnation (or for a segment with no
   row, as sequence 1), `<machine>/<native>.incarnation-<seq>.jsonl` for an archived one.
2. **Per source file**: if the source is absent, the file is done (converted earlier, or
   never written). Otherwise split it into parts at its incarnation's prefix with
   `durable: true`, overwriting any part a crashed run left; read every part back and compare
   it with the source bytes; then delete the source with a directory `fsync`.
3. **Done marker**: when the list is exhausted, an install-level marker records the parted
   layout and later boots skip the step.

*Resuming after a crash.* The step is idempotent per source file: a present source means "not
yet converted", and it is converted again from the start; its parts are overwritten with the
same bytes. A source is removed only after its parts are verified, so no state between the
steps loses bytes. A source shorter than its cursor (an earlier operator incident) is converted
as it is; the mirror's guard repairs the cursor on its next pull.

*Free disk.* One source file at a time: the largest lake file plus a margin. A preflight
checks free space against that before starting and refuses with the number it needs, never
the size of the whole lake.

*What else changes with it.* `docs/spec/transcript-mirror.md` 2.1 describes the new layout;
the two tests that write archived lake files by path (`modules/memory/lake.test.ts`,
`relay.lake-read.test.ts`) write through the lake instead. No tool or script reads lake files.

**Hosted turns the lake on only by decision** (section 4, Q1). The code lands with hosted off.

### 2.4 Artifacts and CLI bundle uploads

Artifact members are already immutable and written whole: they go through `BlobStore.put`
unchanged in shape. Reads go through `get` with the route's range. `remove` and `removeIssue`
become prefix deletes (`list` + `delete`).

CLI bundle uploads write 512 KB packets at offsets and publish by rename. Instead:

- **Chunks become objects**: each packet is `put` at
  `artifacts/.uploads/<issue>/<upload>/<member>/<offset>` with `ifAbsent`, the offset padded to
  12 digits. A retried packet finds its key and compares bytes, which is today's "conflicts
  with previously uploaded bytes" check. An upload holds at most about 1,000 chunk objects
  (500 MB at 512 KB) plus one per member under 512 KB, so at most about 1,200.
- **State moves to a table**, `artifact_uploads` (workspace class: `workspace_id`, issue,
  upload id, the begin packet, received bytes per member, created at). A packet is accepted by
  a conditional update on the received count, which replaces the in-process lock map: two
  processes receiving packets of the same upload are ordered by the database.
- **Publish composes**: each member's chunks are read in key order and streamed to its final
  artifact key (a multipart write on S3, a streamed file on disk), then the staging keys and
  the row are deleted. Publish is already an effect record (POD-6420), so a crash re-runs it;
  the final key is fixed by the artifact id, so a re-run writes the same bytes.
- **A missing chunk at compose** (the row says received but a key is absent, or the chunks do
  not cover the declared size): publish fails the effect with "upload incomplete" and keeps the
  staging, which the day-old sweep removes. Nothing is published half.

Local disk follows the same algorithm. It loses in-place offset writes and pays one copy of the
bundle at publish (at most 500 MB), for one code path instead of two.

### 2.5 Composer uploads

Today a claim moves the file into the artifact store and a failed launch moves it back; the
claim itself lives in `meta.json`.

**Options.**

- **U1. Keep the moves**: `copy` then `delete` on the object store and on disk.
- **U2. Never move**: the artifact records where its bytes are. A claim is a row update and the
  bytes stay at the pending key.
- **U3. Write the upload at its future artifact key from the start.** The issue is unknown
  when the file is picked (a new task's issue does not exist yet), so this fails.

**Tradeoffs.** U2 removes the move but changes the artifact manifest (a member may point at a
foreign key) and leaves claimed files under `pending-uploads/`, where the day-old sweep must
know not to touch them. U1 keeps the manifest and the layout, and the move is small: one file,
at most 100 MB, server-side copy on S3.

**Decision: U1, with the state in a table.** `pending_uploads` (workspace class:
`workspace_id`, id, owner, filename, entry, media type, size, created at, claimed issue and
artifact) replaces `meta.json`. `claimedBy` becomes a query instead of a directory listing,
the sweep a query plus deletes. The claim order stays today's: record the claim in the row,
copy, delete the source. A crash after the copy re-runs to the same artifact key; the sweep
deletes a claimed upload's leftover source.

### 2.6 Readers

`packages/harness` reads lake files by path. It changes to read through a source:

```ts
export interface ByteSource {
  size(): Promise<number>
  read(offset: number, length: number): Promise<Uint8Array>
  /** Changes whenever the bytes may have changed: size + mtime for a file, cursor + open part's etag for the lake. */
  version(): Promise<string>
}
```

`ChainEntry` carries a `ByteSource` instead of a path; `readFileItems`, `readFileWindowed` and
`readIndexWindow` take one; the parsed-slice cache keys on `version()` instead of `stat`. The
daemon wraps its native files in a file-backed source and behaves as today. The server uses
the parted lake's source, whose `size` is `min(cursor, stored size)` and whose `read` issues
one ranged `get` per part it touches: the readers' first window is 256 KB, so one or two, and
more only when a window has doubled past P.

### 2.7 Serving `/files`

**Options.** F1, stream through the server; F2, redirect to a presigned URL per file; F3, a
CDN or edge worker in front of the bucket that accepts a token scoped to an artifact prefix.

**Tradeoffs.** F2 breaks HTML bundles: after the redirect the document's origin is the bucket,
its relative sibling URLs carry no signature and fail; the CSP sandbox header that keeps an
artifact page from touching the app cannot be attached to a presigned response on S3; and the
workspace and membership check happens once, at the redirect. F3 fixes the relative links but
adds an edge component, a token scheme and a second place that must enforce headers. F1 keeps
every rule in one place (the hosted router's path-carried workspace, the client guard, the
sandbox, ranges) at the cost of the server carrying the bytes; reads from R2 have no egress
fee, and the server already carries them today from its volume.

**Decision: F1, streaming.** The route stops buffering whole files. It serves
`/files/artifact/workspace/<ws>/…` only when `<ws>` equals the workspace bound to the request
(POD-6960); the store handle is that workspace's, so another workspace's artifact is simply not
found. The interface has no presign method; one is added when a measurement asks for it.

### 2.8 Configuration and the client library

- `fileStorage` in the server config: `{ backend: 'local' }` (default) or
  `{ backend: 's3', endpoint, bucket, region }` with the key pair from the environment
  (`PODIUM_FILE_STORAGE_*`). Hosted sets it through the environment. A self-hosted operator may
  choose `s3` as well; it is supported, not advertised, until hosted has run on it.
- The adapter uses Bun's built-in S3 client (ranged reads, streamed multipart writes, no new
  dependency). F2 verifies conditional writes (`If-None-Match`, `If-Match`), ranges past the
  end and listing order on R2 through it, and falls back to the AWS SDK v3 S3 client for
  anything it lacks.
- The transfer fence becomes a property of the local adapter: owners stop calling `runWriter`
  themselves. Server transfer (self-hosted only; hosted has none, POD-6965) keeps walking the
  same four roots.

### 2.9 Background work

The hourly sweeps become queries over `pending_uploads` and `artifact_uploads` plus deletes.
In a fleet each sweep must run once: they become lease-owned jobs under POD-6962. Until then
they run where they run today and are safe to run twice (every delete is idempotent).

An orphan audit (list a workspace prefix in key order, compare with the database, delete what
nothing references and is older than a day) covers crashes between an object write and its
row, and lake parts past a shrink that a crash left behind. It also serves POD-6966's deletion
obligations. It runs rarely and per workspace.

### 2.10 What stays out

- The server's own state files (keys, secrets, instance record, update journal, logs, perf
  dumps, snapshots): POD-6974.
- `<state>/handoff`: a stage file that lives for one call. It stays on the process's local
  scratch disk on every backend.
- `<state>/uploads`: the daemon's attachment staging, not server storage.
- Transcript search on Postgres (`transcript_text`): POD-6958. The lake feeds it the same way on
  both backends.
- Storage quotas: POD-6967. Usage is derivable from rows that already exist (`mirrored_bytes`
  and incarnation bytes, artifact manifests' sizes, `pending_uploads.size`); no ledger table.

## 3. Contracts with other sub-epics

| With | This design needs | This design gives |
|---|---|---|
| POD-6959 (workspace partition) | The `WorkspaceId` brand; POD-7012 (Workspace column migration) before the two new workspace-class tables (`pending_uploads`, `artifact_uploads`), which follow its key rules and enter its manifest; the cursor compare-and-set on `conversation_segments` | Nothing in the store files until the child tasks |
| POD-6958 (Postgres) | Both tables in both schemas | — |
| POD-6960 (workspace context) | The workspace bound to each request, for the `/files` route | A route that never takes the workspace from the path alone |
| POD-6961 (placement) | Which process owns a machine's mirror; the fence in 2.3 tolerates overlap | — |
| POD-6962 (background work) | Lease-owned sweeps and the orphan audit | Idempotent sweeps |
| POD-6964 (lifecycle) | — | Export and import copy keys one for one on every root, the lake included; a workspace delete is a prefix delete |
| POD-6965 (hosted ops) | Bucket, credentials and lifecycle rules in the hosted infrastructure | The `fileStorage` config |
| POD-6966 (isolation) | The encryption-at-rest decision before hosted turns the lake on | The two-workspace file isolation tests (F9), feeding its suite |

## 4. Decisions on the open questions

Decided by the POD-6951 coordinator on 2026-11-17, to whom the operator delegated this design.
Q1 is reversible at go-live.

- **Q1. Transcripts on hosted: (b).** The lake is on by default with a per-workspace off
  switch. Hosted stays off until the parted lake (F4) and the isolation proof (F9) have landed
  and POD-6966 has settled encryption at rest. The code lands with hosted off.
- **Q2. Object store: Cloudflare R2.** Only the S3 API is used, so the choice can change.
- **Q3. Serving: streaming through the server** (2.7, F1). No presign method now.

The questions as they were put:

**Q1. Should hosted keep transcripts (turn the lake on)?** Options: (a) on for every hosted
workspace; (b) on, with a per-workspace switch an admin can turn off; (c) off, as today. With
the lake on, a teammate can read an agent's transcript after the laptop that ran it goes to
sleep, and transcript search works on hosted; with it off, both need the machine online. On
means storing customers' agent transcripts (their code, prompts and anything an agent printed,
secrets included): storage cost, a deletion and export obligation, and a privacy statement.

**Q2. Which object store?** (a) Cloudflare R2, already provisioned for the hosted state
archive, no egress fees, no append (not needed); (b) Tigris, S3-compatible and next to the Fly
machines; (c) AWS S3, the richest feature set, with egress fees.

**Q3. Serve hosted files through the server or via signed links?** The options of 2.7.

## 5. Child tasks

Filed under this issue as POD-7049 to POD-7058, not started; F6 and F7 also wait for POD-7012. Each is sized for one worker. "Owns" lists the files it
writes; tasks that can run at the same time own disjoint files. No task runs the full suite.

| # | Task | Owns | Waits for |
|---|---|---|---|
| F1 (POD-7049) | **Blob store and local adapter.** `packages/blob-store`: `BlobStore`, key validator and encoding, local adapter (temp + rename, `durable`, conditional writes, refuses non-`local`, temp cleanup), in-memory adapter with object-store semantics, one contract suite run against both | `packages/blob-store/**` | — |
| F2 (POD-7050) | **S3 adapter and configuration.** Bun S3 client adapter (AWS SDK fallback), `fileStorage` config and env, `forWorkspace` wiring in the composition; the contract suite against R2 in an opt-in lane | `packages/blob-store/src/s3*`, config files, composition | F1 |
| F3 (POD-7051) | **Readers over a byte source.** `ByteSource` in `packages/harness/src/store`, `ChainEntry` and the three readers take it, slice cache keyed on `version()`; the daemon's file-backed source; no behaviour change | `packages/harness/src/store/**`, daemon read call sites | — |
| F4 (POD-7052) | **Parted lake.** `PartedLake` over `BlobStore`; `MirrorService` writes through it (its file code removed); `TranscriptLake` reads its source; conditional part writes; the cursor compare-and-set; shrink and rotation rules; spec 2.1 and the two path-writing tests | `packages/sync/src/mirror.ts`, `packages/sync/src/lake*.ts`, `modules/memory/lake.ts`, the cursor statement in `store/conversations/mirror.ts`, `docs/spec/transcript-mirror.md` | F1, F3 |
| F5 (POD-7053) | **Lake conversion on self-hosted.** The blocking, resumable boot step of 2.3.1 with preflight, verification and done marker; a test that kills it mid-segment and resumes | a new `migrations/lake-parts-conversion.ts` and its boot hook | F4 |
| F6 (POD-7054) | **Artifacts on the blob store.** Snapshot, upload, read (streamed), remove; CLI uploads as chunk objects with `artifact_uploads` and publish by compose | `modules/issues/artifact-store.ts`, the table's migration and repository | F1, POD-7012 |
| F7 (POD-7055) | **Composer uploads on the blob store.** `pending_uploads` table, `PendingUploadStore` and the claim and relinquish paths | `modules/issues/pending-uploads.ts`, its call sites in `crud.ts` and `session-launch-effect.ts`, the table | F6, POD-7012 |
| F8 (POD-7056) | **Streaming `/files` route.** Stream `get` with ranges; refuse a path workspace that differs from the request's bound workspace once POD-6960 provides it | `file-artifact-route.ts`, `modules/files/queries.ts` | F6 |
| F9 (POD-7057) | **Sweeps, orphan audit and file isolation proof.** Table-driven sweeps; per-workspace orphan audit; two workspaces with the same issue, artifact, upload and segment ids over one in-memory bucket (reads, writes, sweeps, route) | sweep code in `relay.ts`, a new audit module, test files | F4, F7, F8 |
| F10 (POD-7058) | **Hosted lake measurement.** Part size, write amplification and read latency of the parted lake against R2 in the opt-in lane; sets P before hosted turns the lake on | a bench script and its report | F2, F4 |

Order: F1 and F3 start at once; F2 and F4 follow; F5, F6 and F10 after them; F7, F8, then F9.
POD-6962's lease for the sweeps and POD-6960's request binding are named in the briefs of F9
and F8; they are not task edges.

## 6. Risks and unknowns

- **Bun's S3 client coverage.** Conditional writes, ranges past the end and listing order on
  R2 are unverified; F2 decides between it and the AWS SDK. Low impact: the adapter is one file.
- **Part size.** 1 MiB is reasoned, not measured. F10 measures it on a real bucket.
- **Lake read latency on hosted.** A transcript window read becomes one or two ranged GETs
  (tens of milliseconds) instead of a local read. The lake is the fallback when the machine is
  offline, and the slice cache still applies.
- **Conversion time on large lakes.** Every lake byte is written once more and read twice
  (split, verify). A multi-GB lake takes minutes at disk speed; the operator accepts a blocking
  upgrade of any length.
- **Publish of large CLI bundles.** Compose copies up to 500 MB through the server in one
  effect run. If that is too slow for a request, publish answers when the effect is recorded
  and the panel row appears when it completes, which the effect machinery already supports.
- **Private hosted repository.** Two facts (the hosted router, the archive bucket) come from
  the hosted deployment's private repository and are described here without its paths.

## 7. Evidence

Read at `0afe9e00e3` on 2026-11-17: `packages/sync/src/mirror.ts`, `modules/memory/lake.ts`,
`modules/memory/transcript-indexer.ts`, `store/conversations/mirror.ts`,
`packages/harness/src/store/slice.ts` and `source.ts`, `modules/issues/artifact-store.ts`,
`modules/issues/pending-uploads.ts`, `file-artifact-route.ts`, `raw-file-headers.ts`,
`file-asset-route.ts`, `modules/server-transfer/portable-fence.ts` and `snapshot.ts`,
`apps/daemon/src/server-transfer.ts`, `apps/daemon/src/control/transcripts.ts`,
`modules/sessions/handoff-transfer.ts`, `modules/sessions/session-launch-effect.ts`,
`migrations/schema.ts` (segments, incarnations, panel artifacts), `store/workspace-manifest.ts`,
and the hosted deployment's workspace router, archive script and deployment design. Every
`stateDir()` join in `apps/server/src` outside tests was listed; the ones not covered above
are the database, `runtime`, `perf` and `mobile-client-versions.json`, which are server state
(POD-6974). Lake paths outside the readers: `git grep` for `.incarnation-` and `transcripts/`
outside docs found only the two tests named in 2.3.1 and the transfer code and tests.
