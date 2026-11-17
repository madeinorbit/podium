# POD-6963: Shared user file storage — design

Status: stage 1 design, for review by the POD-6951 coordinator and the operator. Written
2026-11-17 on `issue/6963-shared-user-file-storage`, cut from `integrate/6951-cloud-hosting` at
`0afe9e00e3`. Paths are relative to `apps/server/src` unless they start with `packages/` or
`docs/`. Nothing here is implemented; no child task is filed yet.

Parent: POD-6954 (Multi-process server runtime), under POD-6951 (Multi-tenant cloud hosting).
Reads with: `docs/design/POD-6959-workspace-partition-design.md` (how a workspace reaches a
repository) and `docs/design/POD-6958-postgres-store-design.md` (branches
`issue/6959-workspace-partitioned-data-model` and `issue/6958-postgres-store-beside-sqlite`).

## 0. The design on one page

- **Hosted object storage is the primary target** (operator principle, 2026-11-16). The
  interface is shaped by what an S3-compatible object store can do: whole-object writes,
  ranged reads, no append, no rename, no write at an offset. Local disk is the special case
  behind the same interface.
- **One small byte interface, `BlobStore`, built for one workspace.** `put`, `get` (with a
  byte range), `head`, `delete`, `list`, `copy`. A store handle is constructed for a
  workspace, the way POD-6959 builds a repository for one (its section 2.4, S3): callers pass
  keys relative to the workspace and cannot name another workspace's prefix.
- **Keys are today's relative paths.** `artifacts/<issue>/<artifact>/<file>`,
  `pending-uploads/<id>/file/<name>`, `transcripts/<machine>/…`. On local disk the `local`
  workspace maps them to exactly today's files under the state directory, so a self-hosted
  install migrates nothing. On hosted the same key lives at `<workspaceId>/<key>` in one
  bucket.
- **Transcripts get their own storage port, with two implementations.** The lake is an
  append-only, resumable, verbatim mirror. Local disk keeps today's single append file per
  segment, unchanged. Object storage stores each segment as fixed-size parts (1 MiB) under an
  incarnation-numbered prefix; only the last part is rewritten as it grows, and the cursor
  already kept in the database says how many bytes exist. No new table, no rename on
  incarnation change.
- **Readers take a byte source, not a path.** The shared transcript slice and index readers in
  `packages/harness` open files by path today. They change to read through a small
  random-access source; the daemon keeps a file-backed one, the server gets a lake-backed one.
- **Metadata leaves the file tree.** Pending uploads and staged CLI uploads keep their state
  in `meta.json` files today; on hosted that would make the bucket a second source of truth
  and force bucket listings. Both move to workspace tables. Bytes stay in the store.
- **`/files` streams through the server on hosted.** No signed redirect for now: an HTML
  bundle's relative links, its sandbox header and the workspace check all depend on the
  server answering. Today's route reads a whole file (up to 100 MB) into memory; it streams
  instead.
- **The fleet needs no file locks.** Each write is fenced by the database: the lake's cursor
  advances by compare-and-set, an upload's received bytes by a conditional update. The
  in-process lock map and per-machine single-flight stay as optimisations, not as the
  guarantee.
- **Self-hosted pays nothing new.** Same files, same layout, same server-transfer snapshot.
  The local adapter adds one function call per file operation.

## 1. What exists today

| Area | Fact | Where |
|---|---|---|
| Transcript lake | `MirrorService` writes `<lakeDir>/<machine>/<nativeId>.jsonl` with raw `node:fs`: open in append mode, `truncate(offset)`, then append. Invariant: lake size equals the cursor before every write | `packages/sync/src/mirror.ts:162`, `:531` |
| Lake incarnations | A replaced native file archives the current copy by `rename` to `<nativeId>.incarnation-<seq>.jsonl`, then re-pulls from zero | `packages/sync/src/mirror.ts:562` |
| Lake state | Cursors are columns of `conversation_segments` (`mirrored_bytes`, `reported_bytes`, `indexed_bytes`) plus an incarnation history table | `migrations/schema.ts:1392-1395`, `:1405` |
| Lake wiring | Lake dir is `<state>/transcripts`, set only when the lake is on; hosted runs with `PODIUM_TRANSCRIPT_LAKE=off` because there is no blob store ("deferred blob-store port" in the hosted deployment design) | `server.ts:774`, `:822` |
| Lake readers | `TranscriptLake.readWindow` builds a file chain of lake paths; `readIndexItems` feeds the search indexer from a path | `modules/memory/lake.ts:203`, `:267` |
| Shared readers | `readFileItems`, `readFileWindowed`, `readIndexWindow` and the parsed-slice cache open and `stat` files by path; the daemon's live `transcriptRead` uses the same code | `packages/harness/src/store/slice.ts:33`, `:158`, `:405`, `:692` |
| Artifacts | `IssueArtifactStore` writes `<state>/artifacts/<issue>/<artifact>/<relpath>`; immutable per artifact id. Pulled from the daemon in 4 MB chunks, written whole | `modules/issues/artifact-store.ts`, `relay.ts:2464` |
| CLI bundle uploads | 512 KB packets written at offsets into `<state>/artifacts/.uploads/<issue>/<upload>/files/…` with `r+`, state in `meta.json`, serialised by an in-process lock map; publish is a `rename` | `artifact-store.ts:154`, `:168`, `:333` |
| Composer uploads | `PendingUploadStore`: `<state>/pending-uploads/<uuid>/meta.json` + `file/<name>`. A claim records the issue in `meta.json`, then the artifact store takes the dir by `rename` (`adopt`); a failed launch moves it back (`relinquish`). `claimedBy` lists the directory | `modules/issues/pending-uploads.ts:138`, `:197`; `artifact-store.ts:401`, `:430`; `modules/issues/service/crud.ts:915-981` |
| Sweeps | Hourly timer in the relay: pending uploads older than a day, staged CLI uploads older than a day (by directory mtime) | `relay.ts:691`, `:4953-4957`, `pending-uploads.ts:172`, `artifact-store.ts:357` |
| Serving | `GET /files/artifact/[workspace/<ws>/]<issue>/<artifact>/<rel>`; non-range reads load the whole file (`readFile`), ranges up to 10 MB; HTML gets a CSP sandbox; `immutable` cache. Authorisation is the `/files/*` client guard only | `file-artifact-route.ts:110-111`, `artifact-store.ts:628`, `raw-file-headers.ts`, `server.ts:1823-1825` |
| Hosted routing | The hosted router reads the workspace from a header, `?workspace=` or the `/files/artifact/workspace/<ws>/` path segment, before auth, so an artifact's relative sibling URLs stay in its workspace | hosted deployment `workspace-router.ts` |
| Transfer fence | `PortableStateFence` gates every writer during a server-transfer snapshot; the snapshot walks `transcripts`, `artifacts`, `uploads`, `pending-uploads` | `modules/server-transfer/portable-fence.ts`, `modules/server-transfer/snapshot.ts:21` |
| `uploads/` | The daemon's chat-attachment staging dir (`<state>/uploads/<session>/<id>.<ext>`); the server only validates refs into it. Present in the snapshot because a co-located daemon shares the state dir | `modules/sessions/receipt-send.ts:130-140`, daemon `runtime/attachment-staging` |
| Handoff | `<state>/handoff/<token>-<ms>.tgz` is a stage file that lives for one call and is removed in `finally` | `modules/sessions/handoff-transfer.ts:121` |
| Hosted object storage | The hosted deployment already writes a daily state archive to an R2 bucket with a SigV4 `curl` | hosted deployment `docker/state-archive.sh` |
| Runtime | Bun 1.4.4 (`mise.toml`), which ships a built-in S3 client (`Bun.S3Client`) | `mise.toml:27` |

Two facts shape everything below. First, the lake's write primitive (truncate then append at
the cursor) has no object-store equivalent: S3-compatible stores replace whole objects.
Second, three flows rely on `rename` being cheap and atomic (CLI publish, adopt, relinquish,
lake archive); on an object store a rename is a copy plus a delete, and neither is atomic with
the other.

## 2. Decisions

### 2.1 The interface (question 1: what is "storage")

**Options.**

- **I1. One filesystem-like interface** (open, write at offset, append, rename, readdir) with
  an object-store emulation underneath. Every caller keeps its shape; the emulation has to
  fake append and rename (copy whole objects, or keep a block map), and hides the cost.
- **I2. A plain object interface for everything** (whole-object put, ranged get, head,
  delete, list, copy) and each owner adapts its algorithm to it, including the lake.
- **I3. I2 for artifacts and uploads, plus a dedicated port for the transcript lake** whose
  local implementation is today's append file and whose object implementation is parts.

**Tradeoffs.** I1 is the least change at the call sites and the worst on hosted: every lake
chunk would become a read-modify-write of an ever larger object or a hidden block index, and
the semantics (what is atomic, what survives a crash) differ by backend while looking the same.
I2 is honest about the object store, but forces the lake into parts on self-hosted too, which
means converting every existing lake file and giving up a free append. I3 keeps one honest
byte interface and admits the one place where the two media really differ.

**Prior art.** Object-store-backed logs write immutable or whole-object segments and keep the
index elsewhere: Kafka tiered storage uploads closed segments; Litestream ships WAL segments as
separate objects. Append exists only as a provider extension (S3 Express One Zone appends,
Azure append blobs, Google Cloud Storage compose), and R2, which hosted uses, has none.

**My call: I3.**

```ts
// packages/blob-store (new, no apps/* imports, so packages/sync can depend on it)
export interface BlobStore {
  put(key: BlobKey, body: Uint8Array | ReadableStream, opts?: {
    contentType?: string
    ifAbsent?: boolean            // refuse when the key exists (S3 If-None-Match: *)
  }): Promise<{ etag: string; size: number }>
  get(key: BlobKey, range?: { offset: number; length: number }):
    Promise<{ body: ReadableStream<Uint8Array>; size: number; etag: string } | undefined>
  head(key: BlobKey): Promise<{ size: number; etag: string } | undefined>
  delete(key: BlobKey): Promise<void>                    // idempotent
  list(prefix: BlobKey): AsyncIterable<{ key: BlobKey; size: number }>  // sweeps and audits only
  copy(from: BlobKey, to: BlobKey): Promise<void>        // server-side on S3; hard link or copy on disk
}
export interface BlobStorage {
  forWorkspace(workspaceId: WorkspaceId): BlobStore
}
```

- `BlobKey` is a branded relative path. One validator mints it: segments of
  `[A-Za-z0-9._-]`, no empty, `.` or `..` segment, no leading `/`. Callers build keys through
  small per-owner functions (`artifactKey(issue, artifact, rel)`), never by string joins.
- `forWorkspace` is called where the workspace's service graph is built (POD-6959 section 2.8:
  one graph per workspace). A store handle cannot be re-pointed.
- `put` is atomic from a reader's point of view on both backends: an object store replaces
  whole objects; the local adapter writes a temp file, `fsync`s it and renames it over the
  key. A reader sees the old bytes or the new ones, never a mix.
- No `rename`. Owners that move bytes today stop moving them (2.4, 2.5); the lake does not need
  to (2.3).

### 2.2 Layout and workspace isolation (question 2)

**Options.**

- **B1. One bucket, a prefix per workspace** (`<workspaceId>/<key>`).
- **B2. A bucket per workspace.**
- **B3. B1 with a per-workspace encryption key** (customer-provided keys or envelope
  encryption in the server).

**Tradeoffs.** B1 is one credential, one lifecycle policy, one place to audit; isolation
rests on the server never building a foreign key, which the per-workspace handle makes
structural. B2 gives a second, provider-enforced wall, but bucket counts are capped per
account, provisioning becomes part of workspace creation (POD-6964), and the server still
holds a credential that can reach every bucket unless it mints scoped credentials per
request. B3 adds cryptographic separation and makes deleting a workspace a key deletion, at
the cost of key custody, and of range reads on encrypted data.

**Prior art.** Multi-tenant SaaS on S3 commonly uses prefix-per-tenant in a shared bucket
with access enforced in the application, moving to bucket-per-tenant only for contractual
isolation.

**My call: B1.** Encryption at rest is the provider's default (R2 encrypts every object).
Per-workspace keys are POD-6966's decision; the lake's fixed-size parts (2.3) keep that option
open, because each part can be encrypted as a unit and still be range-read.

The local adapter maps workspace `local` to the state directory and **refuses every other
workspace id**. A self-hosted install has one workspace, so a second id can only be a bug.
The object adapter accepts `local` too, so a self-hosted operator may point at a bucket (2.8).

| Owner | Key | Local disk (`local`) | Object store |
|---|---|---|---|
| Artifact member | `artifacts/<issue>/<artifact>/<rel>` | `<state>/artifacts/…` (today) | `<ws>/artifacts/…` |
| CLI upload chunk | `artifacts/.uploads/<issue>/<upload>/<member>/<offset>` | `<state>/artifacts/.uploads/…` | `<ws>/artifacts/.uploads/…` |
| Composer upload | `pending-uploads/<uuid>/file/<name>` | `<state>/pending-uploads/…` (today) | `<ws>/pending-uploads/…` |
| Lake segment (local) | `transcripts/<machine>/<native>.jsonl`, `….incarnation-<n>.jsonl` | today's files | not used |
| Lake part (object) | `transcripts/<machine>/<native>/<incarnation>/<part>` | not used | `<ws>/transcripts/…` |

### 2.3 Transcripts (question 3)

The lake's contract stays as it is (`docs/spec/transcript-mirror.md`): verbatim bytes,
resumable from the persisted cursor, lake write before cursor advance, a shrink re-pulls from
zero, a new file identity starts a new incarnation and keeps the old one readable.

**Options for the object store.**

- **T1. One object per segment, rewritten on every chunk.** Simple; write cost grows with the
  transcript (a 50 MB transcript rewrites 50 MB per 256 KB chunk).
- **T2. One object per mirror chunk, indexed in a new table.** No rewrites, but one object and
  one row per pull, many tiny objects for a slowly growing session, and a compaction job.
- **T3. Fixed-size parts.** Part `n` holds bytes `[n·P, (n+1)·P)`. Only the last, open part is
  rewritten as it grows; a full part is never written again. The part list needs no table:
  `mirrored_bytes` says how many parts exist.
- **T4. Keep the unflushed tail in Postgres** and flush full parts to the store. Cheapest
  writes, but transcript bytes in the database, a second read path, and a flush job.

**Tradeoffs.** T3's cost per chunk is bounded by P, not by the transcript: with P = 1 MiB and
256 KB chunks a write moves at most 1 MiB. Readers locate bytes by arithmetic. The crash
argument is today's: the part is written before the cursor advances, and a replay rewrites it
byte-identically. A shrink resets the cursor to zero and later writes overwrite the parts in
order; parts past the cursor are ignored by every reader, and the shrink deletes them after the
cursor reset (the orphan audit, 2.9, catches a crash in between). An incarnation change needs no rename, because parts are keyed by incarnation from the
start: rotating only advances the active sequence in the incarnation table. T2 and T4 buy
cheaper writes with a new table or bytes in Postgres (expensive per GB on hosted) and a
background compactor; neither is needed at the write rates the paced mirror produces (one pull
per segment per scan, at most 16 MB per machine per pass).

**Prior art.** T3 is the fixed-block layout of a block device or of HDFS blocks, with the open
block rewritten; Kafka tiered storage avoids the open block by uploading closed segments only.

**My call: T3 for the object store, and today's append file for local disk**, both behind one
port:

```ts
// packages/sync/src/lake-storage.ts
export interface LakeStorage {
  size(seg: SegmentRef): Promise<number>        // bytes actually stored for the active incarnation
  write(seg: SegmentRef, offset: number, bytes: Uint8Array): Promise<void>  // stored size becomes offset + bytes.length
  rotate(seg: SegmentRef, archivedSequence: number): Promise<number>  // archive the active copy; bytes kept
  source(seg: SegmentRef, incarnation?: number): ByteSource           // for readers (2.6)
}
```

- `AppendFileLake` is today's `writeAt`, `lakeSize` and `archiveCurrent`, moved out of
  `MirrorService` without a change in behaviour. It holds the transfer fence.
- `PartedLake` sits on a `BlobStore`. `write(offset, bytes)` reads the open part's kept prefix
  (bytes `[partStart, offset)`), appends, and writes the part, then each further full part.
  `size` is derived from the open part's `head` and the part number, so the existing
  "lake shorter than cursor" guard (`mirror.ts`, `mirrorOne`) still works.
- Readers are bounded by `min(cursor, stored size)`, never by object size alone, so stale parts
  past a shrink are invisible.
- P is a constant (1 MiB) chosen for write cost; the first `PartedLake` task measures read and
  write latency against a real bucket and may move it.

**The fleet fence.** In a fleet, two processes can mirror the same segment while a daemon's
connection moves (POD-6961). The cursor advance becomes a compare-and-set (`UPDATE … SET
mirrored_bytes = :new WHERE mirrored_bytes = :old`); a writer that loses re-reads the cursor and
starts again. The bytes both writers write are the same source bytes at the same offsets, so a
lost race costs a rewrite, not corruption; the residual case (a stale writer replacing a longer
open part with a shorter one) is caught by the shorter-than-cursor guard and re-pulled. Where
the provider supports conditional PUT (`If-Match` on the part's etag), the part write is fenced
too; the first S3 task verifies that on R2.

**Hosted turns the lake on only by decision** (Q1). The code lands with hosted still `off`.

### 2.4 Artifacts and CLI bundle uploads (question 4)

Artifact members are already immutable and written whole: they go through `BlobStore.put`
unchanged in shape. Reads go through `get` with the route's range. `remove` and `removeIssue`
become prefix deletes (`list` + `delete`).

CLI bundle uploads write 512 KB packets at offsets and publish by rename. On an object store:

- **Chunks become objects**: each packet is `put` at
  `artifacts/.uploads/<issue>/<upload>/<member>/<offset>` with `ifAbsent`. A retried packet
  finds its key and compares bytes, which is today's "conflicts with previously uploaded bytes"
  check.
- **State moves to a table**, `artifact_uploads` (workspace class: `workspace_id`, issue,
  upload id, the begin packet, received bytes per member, created at). A packet is accepted by
  a conditional update on the received count, which replaces the in-process lock map: two
  processes receiving packets of the same upload are ordered by the database.
- **Publish composes**: each member's chunks are read in order and written to its final
  artifact key (a streamed multipart write on S3, a streamed file on disk), then the staging
  keys are deleted. Publish is already an effect record (POD-6420), so a crash re-runs it; the
  final key is fixed by the artifact id, so a re-run overwrites with the same bytes.

Local disk follows the same algorithm. It loses in-place offset writes and pays one copy of the
bundle at publish (the cap is 500 MB), which I accept for one code path instead of two.

### 2.5 Composer uploads (question 5)

Today a claim moves the file into the artifact store and a failed launch moves it back; the
claim itself lives in `meta.json`.

**Options.**

- **U1. Keep the moves**: `copy` then `delete` on the object store, `rename` on disk.
  Non-atomic on the object store; a crash between leaves two copies until a sweep.
- **U2. Never move**: the artifact records where its bytes are. A claim is a row update and the
  bytes stay at the pending key.
- **U3. Write the upload at its future artifact key from the start.** The issue is unknown
  when the file is picked (a new task's issue does not exist yet), so this fails.

**Tradeoffs.** U2 removes the move but changes the artifact manifest (a member may point at a
foreign key) and leaves claimed files under `pending-uploads/`, where the day-old sweep must
know not to touch them. U1 keeps the manifest and the layout, and the move is small: one file,
at most 100 MB, server-side copy on S3.

**My call: U1, with the state in a table.** `pending_uploads` (workspace class: `workspace_id`,
id, owner, filename, entry, media type, size, created at, claimed issue and artifact) replaces
`meta.json`. `claimedBy` becomes a query instead of a directory listing, the sweep a query plus
deletes. The claim order stays today's: record the claim in the row, copy, delete the source.
A crash after the copy re-runs to the same artifact key; the sweep deletes a claimed upload's
leftover source.

### 2.6 Readers (question 6)

`packages/harness` reads lake files by path. It changes to read through a source:

```ts
export interface ByteSource {
  size(): Promise<number>
  read(offset: number, length: number): Promise<Uint8Array>
  /** Changes whenever the bytes may have changed: size + mtime on disk, size + etag on the store. */
  version(): Promise<string>
}
```

`ChainEntry` carries a `ByteSource` instead of a path; `readFileItems`, `readFileWindowed` and
`readIndexWindow` take one; the parsed-slice cache keys on `version()` instead of `stat`. The
daemon wraps its native files in a file-backed source and behaves as today. The server wraps
`LakeStorage.source`. A `PartedLake` source answers a range with one ranged GET per part it
touches: the readers' first window is 256 KB, so it is one or two GETs, and more only when a
window has doubled past P.

### 2.7 Serving `/files` on hosted (question 7)

**Options.**

- **F1. Stream through the server.** The route resolves the workspace, issue and artifact,
  then pipes `BlobStore.get(key, range)` to the response.
- **F2. Redirect to a presigned URL** per file.
- **F3. A CDN or edge worker** in front of the bucket that accepts a token scoped to an
  artifact prefix, carried in the path.

**Tradeoffs.** F2 breaks HTML bundles: after the redirect the document's origin is the bucket,
its relative sibling URLs carry no signature and fail; the CSP sandbox header that keeps an
artifact page from touching the app cannot be attached to a presigned response on S3; and the
workspace and membership check happens once, at the redirect. It would suit large downloads
and video ranges, where bandwidth through the server matters. F3 fixes the relative links but
adds an edge component, a token scheme and a second place that must enforce headers. F1 keeps
every rule in one place (the hosted router's path-carried workspace, the client guard, the
sandbox, ranges) at the cost of the server carrying the bytes; reading from the bucket is free
of egress on R2, and the server already carries them today from its volume.

**My call: F1, streaming.** The route stops buffering whole files. It serves
`/files/artifact/workspace/<ws>/…` only when `<ws>` equals the workspace bound to the request
(POD-6960); the store handle is that workspace's, so another workspace's artifact is simply not
found. F2 for `?download=1` and large media can come later behind a measurement; the interface
already carries what it needs (a `presign` method on the S3 adapter only).

### 2.8 Configuration and the client library (question 8)

- `fileStorage` in the server config: `{ backend: 'local' }` (default) or
  `{ backend: 's3', endpoint, bucket, region }` with the key pair from the environment
  (`PODIUM_FILE_STORAGE_*`). Hosted sets it through the environment. A self-hosted operator may
  choose `s3` as well; it is supported, not advertised, until hosted has run on it.
- The adapter uses Bun's built-in S3 client (ranged reads, streamed multipart writes, presign,
  no new dependency). The first S3 task verifies conditional writes (`If-None-Match`,
  `If-Match`) and listing on R2 through it, and falls back to the AWS SDK v3 S3 client for
  anything it lacks.
- The transfer fence stays a property of the local adapter and `AppendFileLake`: owners stop
  calling `runWriter` themselves. Server transfer (self-hosted only; hosted has none, POD-6965)
  keeps walking the same four directories, which this design does not move.

### 2.9 Background work (question 9)

The hourly sweeps become queries over `pending_uploads` and `artifact_uploads` plus deletes.
In a fleet each sweep must run once: they become lease-owned jobs under POD-6962. Until then
they run where they run today and are safe to run twice (every delete is idempotent).

An orphan audit (list a workspace prefix, compare with the database, delete what nothing
references and is older than a day) covers crashes between an object write and its row. It
also serves POD-6966's deletion obligations. It runs rarely and per workspace.

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
| POD-6959 (workspace partition) | The `WorkspaceId` brand; two new workspace-class tables (`pending_uploads`, `artifact_uploads`) entered in the manifest; the cursor compare-and-set on `conversation_segments` | Nothing in the store files until the child tasks; the tables follow POD-6959's key rules (lead with `workspace_id`) |
| POD-6958 (Postgres) | Both tables in both schemas | — |
| POD-6960 (workspace context) | The workspace bound to each request, for the `/files` route | A route that never takes the workspace from the path alone |
| POD-6961 (placement) | Which process owns a machine's mirror; the fence in 2.3 tolerates overlap | — |
| POD-6962 (background work) | Lease-owned sweeps and the orphan audit | Idempotent sweeps |
| POD-6964 (lifecycle) | — | Export and import copy keys one-for-one; local lake files convert to parts by splitting at P; a workspace delete is a prefix delete |
| POD-6965 (hosted ops) | Bucket, credentials and lifecycle rules in the hosted infrastructure | The `fileStorage` config |
| POD-6966 (isolation) | Per-workspace encryption decision | The two-workspace file isolation tests (task F10), feeding its suite |

## 4. Open questions for the operator

**Q1. Should hosted keep transcripts (turn the lake on)?**

- *Options:* (a) on for every hosted workspace once task F6 lands; (b) on, with a per-workspace
  switch an admin can turn off; (c) off, as today.
- *Example:* with the lake on, a teammate can read an agent's transcript after the laptop that
  ran it goes to sleep, and transcript search works on hosted. With it off, both need the
  machine to be online.
- *Tradeoffs:* (a) and (b) mean we store our customers' agent transcripts, which hold their
  code, prompts and anything an agent printed (secrets included): storage cost, a deletion and
  export obligation (POD-6966), and a privacy statement to write. (c) costs nothing and keeps
  hosted weaker than self-hosted.
- *Prior art:* hosted CI services keep build logs by default with a retention period and a
  per-project setting.
- *Recommendation:* (b), default on, after POD-6966 settles encryption at rest. The code lands
  either way.

**Q2. Which object store for hosted?**

- *Options:* (a) Cloudflare R2, already provisioned for the hosted state archive; (b) Tigris
  (Fly's S3-compatible store); (c) AWS S3.
- *Tradeoffs:* R2 has no egress fees and is already in the infrastructure; it has no append (not
  needed by this design). Tigris sits next to Fly machines and caches globally. S3 has the
  richest feature set and egress fees.
- *Recommendation:* (a). The design uses only the S3 API, so the choice can change later.

**Q3. Serve hosted files through the server, or signed links?**

- *Options:* F1, F2 or F3 of 2.7.
- *Recommendation:* F1, streaming, with a signed-link fast path for downloads only if
  measurement shows the server's bandwidth matters.

## 5. Child tasks

To be filed under this issue once the design is approved; none is filed or started. Each is
sized for one worker. "Owns" lists the files it writes; tasks that can run at the same time own
disjoint files. No task runs the full suite: each runs its focused files, and the tasks that
touch the store run the store shard.

| # | Task | Owns | Waits for |
|---|---|---|---|
| F1 | **Blob store interface and local adapter.** `packages/blob-store`: `BlobStore`, `BlobKey` validator, local adapter (temp + fsync + rename, refuses non-`local`), an in-memory adapter with object-store semantics, and one contract test suite run against both | `packages/blob-store/**` | — |
| F2 | **S3 adapter and configuration.** Bun S3 client adapter (fallback AWS SDK), `fileStorage` config and env, `forWorkspace` wiring in the composition; verifies conditional writes, ranges and listing on R2 (opt-in lane, not the default gate) | `packages/blob-store/src/s3*`, config files, composition | F1 |
| F3 | **Readers over a byte source.** `ByteSource` in `packages/harness/src/store`, `ChainEntry` and the three readers take it, slice cache keyed on `version()`; the daemon's file-backed source; no behaviour change | `packages/harness/src/store/**`, daemon read call sites | — |
| F4 | **Lake storage port, local implementation.** `LakeStorage`, `AppendFileLake` from today's `MirrorService` file code; `TranscriptLake` reads through `source()`; the cursor compare-and-set | `packages/sync/src/mirror.ts`, `packages/sync/src/lake-storage*.ts`, `modules/memory/lake.ts`, the cursor statement in `store/conversations/*` | F3 |
| F5 | **Artifacts on the blob store.** Snapshot, upload, read (streamed), remove; CLI uploads as chunk objects with `artifact_uploads` and publish by compose | `modules/issues/artifact-store.ts`, the new table's migration and repository | F1, the POD-6959 table conventions |
| F6 | **Parted lake.** `PartedLake` over `BlobStore`, incarnation-keyed parts, cursor-bounded reads, conditional part writes where supported; measure P on a real bucket | `packages/sync/src/lake-parted*.ts` | F2, F4 |
| F7 | **Composer uploads on the blob store.** `pending_uploads` table, `PendingUploadStore` and the claim/relinquish paths in `crud.ts` and `session-launch-effect.ts` | `modules/issues/pending-uploads.ts`, its call sites, the table | F5 (shares the artifact store's adopt and relinquish) |
| F8 | **Streaming `/files` route with the workspace check.** Stream `get` with ranges; refuse a path workspace that differs from the request's | `file-artifact-route.ts`, `modules/files/queries.ts` | F5, POD-6960's request binding |
| F9 | **Sweeps and orphan audit.** Table-driven sweeps; per-workspace orphan audit; lease-owned when POD-6962 lands | sweep code in `relay.ts`, a new audit module | F5, F7 (lease: POD-6962) |
| F10 | **File isolation proof.** Two workspaces with the same issue, artifact and upload ids over one bucket (in-memory and opt-in real); reads, writes, sweeps, the route. Feeds POD-6966 | test files only | F5–F9 |

Order: F1 and F3 start at once; F2, F4 and F5 follow; F6 and F7 after them; F8, F9, F10 last.
Hosted turns the lake on (Q1) only after F6 and F10.

## 6. Risks and unknowns

- **Bun's S3 client coverage.** Conditional writes and listing behaviour on R2 are unverified;
  F2 decides between it and the AWS SDK. Low impact: the adapter is one file.
- **Part size.** 1 MiB is reasoned, not measured. F6 measures write amplification and read
  latency on a real bucket.
- **Lake read latency on hosted.** A transcript window read becomes one or two ranged GETs
  (tens of milliseconds) instead of a local read. The lake is the fallback when the machine is
  offline, and the slice cache still applies.
- **Publish of large CLI bundles.** Compose copies up to 500 MB through the server in one
  effect run. If that is too slow for a request, publish answers when the effect is recorded
  and the panel row appears when it completes, which the effect machinery already supports.
- **Private hosted repository.** Two facts (the hosted router, the archive bucket) come from
  the hosted deployment's private repository and are described here without its paths.

## 7. Evidence

Read at `0afe9e00e3` on 2026-11-17: `packages/sync/src/mirror.ts`, `modules/memory/lake.ts`,
`modules/memory/transcript-indexer.ts`, `packages/harness/src/store/slice.ts` and `source.ts`,
`modules/issues/artifact-store.ts`, `modules/issues/pending-uploads.ts`,
`file-artifact-route.ts`, `raw-file-headers.ts`, `file-asset-route.ts`,
`modules/server-transfer/portable-fence.ts` and `snapshot.ts`,
`modules/sessions/handoff-transfer.ts`, `modules/sessions/session-launch-effect.ts`,
`migrations/schema.ts` (segments, incarnations, panel artifacts),
`store/workspace-manifest.ts`, and the hosted deployment's workspace router, archive script and
deployment design. Every `stateDir()` join in `apps/server/src` outside tests was listed; the
ones not covered above are the database, `runtime`, `perf` and `mobile-client-versions.json`,
which are server state (POD-6974).
