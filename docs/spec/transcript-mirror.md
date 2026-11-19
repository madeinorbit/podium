# Spec: Transcript Lake + Hub Mirror (Phase P4, core)

Status: **approved for implementation** · 2026-07-02
Architecture context: `docs/offline-sync-architecture.md` §6.1. Builds on the
conversation registry (P1): segments already record each native transcript's
absolute path as evidence. This phase makes the server hold a **verbatim, durable
copy** of every transcript — the backup substrate ("agents delete their own
history; Podium doesn't") and the prerequisite for server-side search (P5) and
offline transcript sync (P6).

## 1. Problem

Transcripts exist ONLY on the daemon machine, in files the agent owns and may
delete (Claude prunes after ~30 days). The server has no copy: reads round-trip to
the daemon (offline hub daemons = no transcript at all), a lost laptop = lost
history, and P5's FTS index has nothing server-side to index.

## 2. Design

### 2.1 The lake (parted, on the blob store)

Amended 2026-11-17 (POD-6963 design 2.3): one parted lake on every backend.

- The lake lives on the workspace's blob store (`packages/blob-store`), not at
  file paths. On a self-hosted install that is the local adapter, so the bytes
  sit under `$PODIUM_STATE_DIR/transcripts/`; on hosted object storage they sit
  under `<workspaceId>/transcripts/`. The code is the same `PartedLake`
  (`packages/sync/src/lake-parted.ts`); the adapter is the only difference.
- **Parts.** Each incarnation of a segment is stored as fixed-size parts of
  P = 1 MiB: part `n` holds bytes `[n·P, (n+1)·P)` under
  `transcripts/<machineId>/<nativeId>/<incarnation>/<part>`. The incarnation and
  the part number are zero-padded to 8 digits; an id outside the key alphabet is
  encoded as `~` + lower-case base32. No table lists parts: the cursor says how
  many bytes, and so how many parts, exist.
- **Incarnations.** The incarnation is the active
  `conversation_segment_incarnations` row's `sequence`, or 1 for a segment
  mirrored before file identities existed; adopting such a segment creates
  sequence 1 for exactly those bytes, so no key changes. When a provider reuses
  the same native id for a different file identity, nothing moves: the
  predecessor's parts already sit under their own sequence. The rotation retires
  the row with its readable byte count and starts the next sequence at a clean
  cursor. `conversation_segments` remains the current native-id projection.
- **Writes.** Only the open last part is rewritten as the segment grows. A write
  reads the open part's kept prefix with its etag, appends, and puts the part
  with `ifMatch` that etag (`ifAbsent` for a new part); a write that crosses a
  part boundary completes that part and starts the next. A put is durable (on
  local disk: file and directory fsync) when it completes a part or replaces
  bytes past its own offset; every other put only extends the part's own prefix
  and is not synced, as appends never were.
- **Size.** The stored size is `openPart · P + size(openPart)`, where the open
  part is the one the cursor points into. Readers see `min(cursor, stored
  size)` through a byte source whose id is
  `<workspaceId>/transcripts/<machineId>/<nativeId>/<incarnation>` and whose
  version is the cursor plus the open part's etag.
- **Shrink.** A rewrite deletes every part of the active incarnation, lowest
  first and durably, before the cursor resets to zero. A stored size reads as
  zero while part 0 is missing, so a crash midway through the delete re-pulls
  from zero.
- Parts are **byte-verbatim** copies (append-only mirror of an append-only
  source). No parsing, no re-encoding — fidelity is the point (arch §6.1).
- **Fleet fence.** Two processes may mirror the same segment while a daemon's
  connection moves. Part writes are conditional (above), the cursor advance is a
  compare-and-set (`mirrored_bytes = :new WHERE mirrored_bytes = :old`), and a
  rotation retires only the incarnation the writer observed. A writer that loses
  any of the three re-reads the cursor and starts the segment over.
- Existing self-hosted lakes of whole files (`<machineId>/<nativeId>.jsonl` and
  `<nativeId>.incarnation-<sequence>.jsonl`) are split into parts by a one-time
  upgrade step (POD-6963 design 2.3.1).

### 2.2 Mirror state (columns on `conversation_segments`, additive)

- `mirrored_bytes INTEGER NOT NULL DEFAULT 0` — bytes durably copied so far (the
  pull cursor).
- `mirrored_at TEXT` — last successful pull (staleness/telemetry).

### 2.3 Sync mechanism: server-driven ranged pulls

New daemon⇄server control messages:

```
server → daemon: transcriptMirrorRead { requestId, path, offset, maxBytes }
daemon → server: transcriptMirrorResult {
  requestId, data (base64), fileSize, eof,   // data may be empty when offset ≥ size
  device?, inode?,                          // identity of the opened file
  error?                                     // unreadable/denied — server backs off
}
```

- **Daemon-side path guard**: the daemon serves ONLY paths inside a discovery
  provider root (e.g. `~/.claude/projects/`) resolved via realpath prefix check —
  the mirror can never be used as an arbitrary file reader. (Same posture as the
  file-relay `knownPath` gate, but root-scoped since mirror paths come from
  discovery evidence, not sessions.)
- **Server-side pull loop** (`MirrorService`): per-machine serial queue (one
  in-flight read per machine — transcripts are cold data; never compete with the
  PTY path), 256 KB chunks, repeat until `eof`. Writes the bytes into the lake at
  the cursor, then advances `mirrored_bytes` by compare-and-set (lake write BEFORE
  cursor advance — a crash re-pulls a chunk, writes are idempotent by offset since
  we write at the cursor). A lake that holds fewer bytes than the cursor (wiped,
  partially restored, or a lost unsynced rewrite) moves the cursor back to what is
  stored before the next pull; the re-pull is byte-identical.
- **Replacement vs rewrite detection**: a changed device/inode for the same
  native id retires the old incarnation as an immutable predecessor and re-mirrors
  the replacement from 0 under the next sequence. Only `fileSize < mirrored_bytes`
  on the *same* file identity is an in-place rewrite that invalidates and deletes
  one incarnation's parts. Transcript reads pass the retired incarnations and the
  current one to the transcript reader as one ordered chain of byte sources.
- **Triggers**: after `indexConversations` (a scan reported new/changed
  conversations — enqueue every segment whose evidence path is known), and a
  low-frequency sweep on daemon attach (catch-up after server downtime). Dedup:
  a segment already queued/in-flight is not re-enqueued.
- **Dirty-driven (redesign, 2026-07)**: full sweeps made every trigger cost one
  daemon eof-check round trip per path-known segment even when fully mirrored
  (~1,150 reads ≈ 2 s wall / 0.9 s CPU per attach, latency-bound noise on the hot
  control channel). Discovery already stats every transcript for mtime, so the
  size now rides along for free: `AgentConversationSummary.sizeBytes` →
  `ConversationSummaryWire.sizeBytes` → persisted as `reported_bytes` on
  `conversation_segments` (additive, NULLable). Scan/attach triggers enqueue ONLY
  the dirty set (`path IS NOT NULL AND (reported_bytes IS NULL OR reported_bytes
  != mirrored_bytes)`); a caught-up machine enqueues nothing and issues zero
  mirror reads. `reported_bytes` persists, so an attach BEFORE the first scan
  reconciles from last-known sizes (the ~15 s scan refreshes them).
  *Upgrade path*: pre-upgrade rows (and providers that never report a size, e.g.
  opencode's SQLite-backed sessions) have NULL `reported_bytes` and count as
  dirty; when a pull reaches eof the mirror records the observed size, so each
  such segment costs exactly one catch-up pull and then goes quiet. Consequence
  for size-less providers: growth after that one pull is no longer noticed —
  acceptable, the mirror formally covers file-path providers (§2.5), which all
  report sizes now. *Correctness*: a size report racing an append is harmless
  (the next scan reports the newer size and re-dirties); a SAME-SIZE rewrite
  with different content remains undetectable — unchanged from the full-sweep
  posture, which keyed off `mirrored_bytes` the same way. The full-sweep
  `enqueueMachine` survives as a manual-reconcile/test seam only.
- **Pacing (incident amendment, 2026-07)**: the first live deploy enqueued a
  months-deep lake on daemon attach and drained it back-to-back — continuous
  256 KB chunks pumped through the daemon WS, decoded and written with zero idle.
  The server sat at ~80% CPU, starved its own daemon-reply handling
  (`transcript mirror failed: timeout`), missed the systemd watchdog's 30 s
  sd_notify deadline and was SIGABRT'd into a restart→re-bootstrap crash loop.
  Two constructor-injectable knobs (`MirrorServiceOptions`) now bound the duty
  cycle: an **inter-chunk delay** (default 25 ms, unref'd setTimeout after every
  chunk write) so the loop breathes between chunks, and a **per-pass byte
  budget** (default 16 MB per machine per drain pass) — when spent, the pass
  stops and clears the remaining queue's queued-state; the next trigger (~15 s
  scan / attach sweep) re-enqueues and resumes from the persisted cursors.
  Design stance: a big-lake bootstrap deliberately spreads over
  minutes-to-hours — transcripts are cold data (invariant 4), and watchdog
  compatibility is a hard requirement, so the mirror must never own the loop.

### 2.4 Wire/read integration (backup becomes useful immediately)

- `transcriptRead` lake-fallback (*deferred to the P5 branch — amended during
  implementation*): serving reads from the mirror requires the server to parse
  JSONL via agent-bridge's `fileChainSource`, and `@podium/server` deliberately
  does NOT depend on agent-bridge today — adding a workspace dep changes the
  lockfile and needs a coordinated `bun install` on the live checkout (the known
  redeploy crash-loop hazard). P5 (search) needs that dependency anyway; the
  fallback read lands with it. THIS phase's deliverable is the durable copy.
- Export (follow-on, needs UI/UX decisions): a `conversations.export` route
  bundling a conversation's segments + registry row. The DURABLE COPY is this
  phase's deliverable; export surfaces ride on it.

### 2.5 Out of scope (follow-ons)

Blob/attachment extraction (content-addressed store), retention policy knobs,
export UI, node⇄hub lake sync (P7), indexing the lake (P5), mirroring
non-file-backed harnesses (opencode SQLite) — the mirror covers every provider
that reports a file path.

## 3. Invariants

1. A lake incarnation's parts are byte-identical prefixes of their source
   (verbatim; rewrite → delete-and-recopy, never interleave).
2. `mirrored_bytes` never exceeds the lake's stored size for long: the cursor
   advances only after a successful part write, and a lake found shorter (a lost
   unsynced rewrite, a wipe) moves the cursor back before the next pull.
3. The daemon never serves a mirror read outside its discovery roots.
4. Mirror traffic never blocks session traffic (serial per machine, bounded
   chunks, queue processed off the hot path).

## 4. Testing

- Store: mirror-cursor columns round-trip; segments-needing-mirror query.
- MirrorService with a fake daemon, on the local and in-memory blob adapters:
  full pull in chunks → byte-identical lake; incremental append → only the tail
  is pulled; rewrite (smaller file) → delete + full re-pull; daemon error →
  backoff, no cursor advance; per-machine serialization (no interleaved requests).
- PartedLake (`lake-parted.test.ts`): part boundaries, shrink, rotation, a lost
  rewrite repaired by the guard, a stale writer refused by `ifMatch`, a lost
  cursor compare-and-set, two writers rotating once.
- Daemon guard: path under a discovery root serves; `/etc/passwd` (and a
  symlink escaping the root) is refused.

## 5. Acceptance

- After a scan, every discovered Claude conversation's JSONL has a byte-identical
  copy in the server's lake, kept fresh as conversations grow.
- Deleting the native file (or detaching the daemon) no longer loses the BYTES:
  a byte-identical copy survives on the server (UI fallback reads land with P5).
- A server restart resumes mirroring from the stored cursors without re-pulling
  everything.
