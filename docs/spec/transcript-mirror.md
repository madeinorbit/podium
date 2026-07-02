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

### 2.1 The lake (server filesystem)

- Location: `$PODIUM_STATE_DIR/transcripts/<machineId>/<nativeId>.jsonl`.
  **Evidence-keyed, not identity-keyed** — machineId+nativeId is the segment PK,
  is immutable, and never needs renames when registry lineage links segments
  later; conversation-level views (export, search) join through
  `conversation_segments.podium_id`.
- Files are **byte-verbatim** copies (append-only mirror of an append-only
  source). No parsing, no re-encoding — fidelity is the point (arch §6.1).

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
  PTY path), 256 KB chunks, repeat until `eof`. Appends bytes to the lake file,
  then advances `mirrored_bytes` (file write BEFORE cursor advance — a crash
  re-pulls a chunk, appends are idempotent by offset since we write at the cursor).
- **Rewrite/truncate detection**: `fileSize < mirrored_bytes` → the native file was
  rewritten (not appended) → truncate the lake copy and re-mirror from 0.
  Verbatim-mirror correctness beats delta cleverness here.
- **Triggers**: after `indexConversations` (a scan reported new/changed
  conversations — enqueue every segment whose evidence path is known), and a
  low-frequency sweep on daemon attach (catch-up after server downtime). Dedup:
  a segment already queued/in-flight is not re-enqueued.
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

1. Lake files are byte-identical prefixes of their source (verbatim; rewrite →
   truncate-and-recopy, never interleave).
2. `mirrored_bytes` never exceeds the lake file's actual size (cursor advances
   only after a successful append).
3. The daemon never serves a mirror read outside its discovery roots.
4. Mirror traffic never blocks session traffic (serial per machine, bounded
   chunks, queue processed off the hot path).

## 4. Testing

- Store: mirror-cursor columns round-trip; segments-needing-mirror query.
- MirrorService with a fake daemon: full pull in chunks → byte-identical lake
  file; incremental append → only the tail is pulled; rewrite (smaller file) →
  truncate + full re-pull; daemon error → backoff, no cursor advance; per-machine
  serialization (no interleaved requests).
- Daemon guard: path under a discovery root serves; `/etc/passwd` (and a
  symlink escaping the root) is refused.

## 5. Acceptance

- After a scan, every discovered Claude conversation's JSONL has a byte-identical
  copy under the server's state dir, kept fresh as conversations grow.
- Deleting the native file (or detaching the daemon) no longer loses the BYTES:
  a byte-identical copy survives on the server (UI fallback reads land with P5).
- A server restart resumes mirroring from the stored cursors without re-pulling
  everything.
