# Spec: Conversation Registry + Stable Identity (Phase P1)

Status: **approved for implementation** · 2026-07-02
Architecture context: `docs/offline-sync-architecture.md` §6.2. This spec covers the
identity keystone: Podium-owned conversation IDs above raw agent artifacts, the
wrong-bucket transcript-loading bug fix, and the repo-wide stable-ID discipline.

## 1. Problems

1. **Transcripts fail to load after a session moves worktrees (live bug).** Claude
   Code buckets transcripts by the cwd the conversation was *created* under
   (`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`). Podium restamps
   `session.cwd` when the agent moves (worktree follow), and THREE independent
   consumers re-derive the path from the *current* cwd: the on-demand read
   (`agent-bridge transcript/file-chain.ts`), reattach tailing
   (`daemon.ts tailResumeTranscript`), and boot-state classification
   (`agent-state/claude-code.ts claudeBootEvents`). After a move, all three look in
   the wrong bucket → blank transcript / wrong idle classification, while the LIVE
   tail keeps working (hooks carry the authoritative `transcript_path`) — which is
   why the bug looks intermittent.
2. **Conversation identity is a native artifact.** `conversations.id` IS the
   agent's session id; a resume that rolls into a new file becomes a brand-new
   conversation with no lineage. Nothing in Podium can say "these two files are the
   same conversation," which breaks resume UX, search grouping, and the future
   transcript lake/backup (P4) and sync (P6/P7).
3. **Mutable attributes used as identity across the codebase** (audit below).

## 2. Identity discipline (repo-wide rule)

**Rule: every entity gets a Podium-generated, immutable, globally-unique ID at
creation. Native/agent artifacts (session ids, file paths, cwds, repo paths) and
human-facing attributes are EVIDENCE or LABELS, never identity.** Agents are
explicitly covered: an agent instance is identified by its Podium session id while
running and by its conversation's `podiumId` across resumes/rolls/moves — the
native harness id is a lookup hint only.

Current state (from the audit):

| Entity | Identity today | Verdict |
|---|---|---|
| Machine | `machines.id` | ✅ stable |
| Session | `sessions.id` (Podium UUID) | ✅ stable — but `cwd` is mutable and was misused as a path-derivation key (§1.1) |
| Conversation | native agent session id | ❌ fixed by this spec (`podiumId`) |
| Issue | `iss_<uuid>` | ✅ stable (display `seq` is per-repo-path — cosmetic, acceptable) |
| Issue comment | `cmt_<uuid>` | ✅ stable |
| Queued message / mutation | client-generated UUID | ✅ stable |
| Superagent thread | `'global'` / `btw_<sessionId>` | ⚠️ embeds a session id; tolerable (session ids are stable) |
| Superagent message | SQLite AUTOINCREMENT | ⚠️ not sync-safe; migrate when superagent joins the oplog (follow-on issue) |
| Repo / worktree | `(machine_id, path)` / raw path strings | ⚠️ path-as-identity; same bug class as conversations. Follow-on issue: `repo_id` + path-as-attribute |
| Transcript cursor | `fileId = sha1(absolute path)` | ⚠️ a moved file invalidates cursors; mitigated by segment records (path changes become explicit) — full fix rides P4's lake |

The ⚠️ rows become tracked issues, not part of P1's diff.

## 3. Design

### 3.1 Registry model (server store)

```sql
-- The identity: one row per logical conversation, Podium-generated, immutable.
CREATE TABLE conversation_identities (
  podium_id   TEXT PRIMARY KEY,          -- 'conv_<uuid>'
  parent_podium_id TEXT,                 -- subagent hierarchy (nullable)
  created_at  TEXT NOT NULL
);
-- The evidence: one row per native artifact (file/native-session), linked to its
-- identity. A resume-roll adds a SEGMENT, not a new conversation.
CREATE TABLE conversation_segments (
  machine_id  TEXT NOT NULL,
  native_id   TEXT NOT NULL,             -- agent's session id (Claude uuid, …)
  provider_id TEXT NOT NULL,
  podium_id   TEXT NOT NULL,             -- -> conversation_identities
  path        TEXT,                      -- last known ABSOLUTE transcript path (evidence)
  seq_in_conv INTEGER NOT NULL,          -- segment order within the conversation
  linked_by   TEXT NOT NULL,             -- 'live-roll' | 'resume-origin' | 'discovery' (provenance/confidence)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (machine_id, native_id)
);
```

- Existing `conversations` rows (native summaries) stay as-is; the registry maps
  each `(machine_id, native id)` onto a `podium_id`. Indexing a native conversation
  with no segment row mints a fresh identity (`linked_by: 'discovery'`).
- **Lineage via the live session (the cheap, high-confidence 90%):** when a LIVE
  session's resume ref rolls to a new native id (Claude resumed into a fresh file),
  the server already observes old→new on the same Podium session — link the new
  native id to the SAME `podium_id` as a new segment (`linked_by: 'live-roll'`).
  Same for resume-origin spawns (`origin.conversationId` names the prior native id →
  `linked_by: 'resume-origin'`). Cold-scan fingerprint matching (leading-uuid
  chains) is the offline fallback and is DEFERRED to a follow-on — mis-merging is
  the failure mode to avoid, and the live path needs no heuristics.
- Subagents: discovery already yields `parentConversationId` (native) — resolve it
  through the registry to `parent_podium_id`.

### 3.2 Wire (additive)

`ConversationSummaryWire` gains `podiumId?: string` (and keeps `id` = native for
existing consumers). `SessionMeta` gains `conversationPodiumId?: string`. The
resume picker / search / grouping migrate to `podiumId` as follow-ons; nothing
breaks meanwhile. Registry rows ride the existing conversation flow through the
P2 oplog untouched.

### 3.3 The transcript-path fix (daemon/agent-bridge; ships first)

One shared locator replaces all three fragile derivations:

```
locateClaudeSessionFile(homeDir, cwd, resumeValue):
  1. exact:   ~/.claude/projects/<slug(cwd)>/<resumeValue>.jsonl   (today's path)
  2. recorded evidence: the segment record's `path` when the daemon has one
  3. bucket sweep: ~/.claude/projects/*/<resumeValue>.jsonl        (filename is the
     native session id — unique across buckets; newest mtime wins on freak ties)
```

Consumers: `resolveFileChain` (transcriptRead), `tailResumeTranscript` (reattach),
`claudeBootEvents` (boot classification). Step 3 alone fixes the moved-worktree
and deleted-worktree cases; step 2 makes it O(1) once segments exist. The daemon
reports the RESOLVED absolute path back with reads/tails so the server can record
it on the segment (evidence flows toward the registry, never from cwd).

### 3.4 Out of scope (filed as issues)

Fingerprint resolver for cold scans; resume-picker/search regrouping by
`podiumId`; repo/worktree `repo_id`; superagent message ids; cursor
`fileId`-by-content; transcript lake (P4).

## 4. Testing

- Locator: exact hit; moved-cwd → bucket sweep finds it; deleted worktree dir →
  sweep still finds it; two buckets with same filename → newest wins; codex path
  (non-bucketed) unaffected.
- Daemon: transcriptRead for a session whose cwd was restamped returns the
  transcript (regression test for the live bug); reattach tail re-binds via
  locator; bootEvents classify from the moved bucket.
- Registry: mint-on-discovery; live-roll links new native id to same podium_id
  with seq_in_conv 2; resume-origin linking; subagent parent resolution;
  idempotent re-indexing (same native id never re-mints).
- Wire: podiumId present on conversations after scan; SessionMeta carries
  conversationPodiumId once known.

## 5. Acceptance

- A session moved to a different worktree (and one whose original worktree was
  deleted) loads its full transcript on demand and reattaches its tail — the
  reported bug is dead.
- Resuming a conversation into a new native file yields ONE conversation identity
  with two segments, observable via `podiumId` on the wire.
- No existing consumer of native conversation ids changes behavior.
