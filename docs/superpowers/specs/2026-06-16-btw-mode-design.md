# `/btw` mode for chat transcripts — design

Date: 2026-06-16
Branch: `worktree-btw-mode`

## Concept

From any Podium chat transcript, a **"BTW" button** (next to the archive button)
spins up a **continuable superagent thread** seeded with context about that
session. The superagent then has its full tool belt — read the full transcript on
demand, search other conversations, start/steer agents, create worktrees, work
Linear — to help with or continue that work.

Unlike Claude Code's one-shot `/btw`, this thread persists, can be continued, and
is the orchestrator (not the worker). We deliberately **do not** intercept the
text command `/btw` typed into a session composer — that belongs to the
underlying agent (Claude Code has its own `/btw`). Entry is a button only.

## Goals

- One click from a transcript → a superagent thread that already knows what that
  session was doing.
- The thread is **linked to its origin session** and **re-openable**. On re-open,
  if the source conversation advanced, the agent is told what is new since it last
  looked, using message-id / timestamp markers.
- Cheap by default: seed a summary + all user messages + a recent tail (~$0.05–0.08
  per launch); the full transcript is pulled on demand via a tool only when needed.

## Non-goals (YAGNI)

- No general multi-thread superagent UI beyond what `/btw` needs (one global thread
  + N btw threads is enough).
- No multiple btw threads per origin session — one active btw thread per session;
  the button re-opens it.
- No new summarization model/pipeline — reuse the conversation's stored `summary`
  when present; otherwise the agent's own opening turn produces the orientation.
- No prompt-caching work (separate concern).

## Token budget (measured)

Tokenized the 52 real session transcripts on this machine (Opus 4.8 input
$5.00/1M, ~3.5 chars/tok):

| Seeded as context | Median | Mean | p90 |
|---|---|---|---|
| Prose only (user+assistant) | ~10k tok · $0.05 | ~14k · $0.07 | ~25k · $0.13 |
| **All user messages only** | ~5k tok · $0.02 | ~9k · $0.05 | ~16k · $0.08 |
| All conversation (＋tool I/O) | ~60k tok · $0.30 | ~79k · $0.40 | ~167k · $0.84 |

So **summary + all user messages + recent tail ≈ $0.05–0.08/launch**, with the
full transcript ($0.30–0.40) pulled only on demand. None of the 52 sessions exceed
Opus 4.8's 1M context window.

## Architecture

### 1. Superagent threads (data model)

`apps/server/src/store.ts`:

- New table `superagent_threads`:
  ```
  id TEXT PRIMARY KEY            -- e.g. 'global' or 'btw_<sessionId>'
  kind TEXT NOT NULL             -- 'global' | 'btw'
  origin_session_id TEXT         -- null for global
  title TEXT
  watermark_item_id TEXT         -- last origin transcript item id seeded (btw only)
  watermark_ts TEXT              -- last origin item ts seeded (btw only)
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  archived INTEGER NOT NULL DEFAULT 0
  ```
- Add `thread_id TEXT NOT NULL DEFAULT 'global'` to `superagent_messages`.
- **Migration (zero loss):** create the `global` thread row if absent; existing
  `superagent_messages` keep `thread_id='global'` via the column default. The
  current global superagent chat is preserved.
- Thread-aware store methods: `listSuperagentThreads()`,
  `getSuperagentThread(id)`, `upsertSuperagentThread(...)`,
  `setThreadWatermark(id, itemId, ts)`, and `thread_id` params on
  `loadSuperagentMessages`, `appendSuperagentMessage`, `clearSuperagentMessages`.

### 2. `SuperagentService` (thread-scoped)

`apps/server/src/superagent.ts`:

- `send(threadId, text)`, `history(threadId)`, `listThreads()`; per-thread busy
  lock (a `Map<threadId, Promise>`), so the global thread and a btw thread don't
  block each other. `runTurn` keys history off `threadId`.
- New `startBtw({ sessionId }): Promise<{ threadId, isNew }>`:
  1. `threadId = 'btw_' + sessionId`. If an unarchived thread exists → re-open path;
     else create it (`kind='btw'`, `origin_session_id=sessionId`).
  2. Fetch transcript via `registry.readTranscript({ sessionId })` (live **or**
     disk — works for parked/hibernated/exited sessions).
  3. **New thread:** build the seed (below), record it as a `user` context
     message, set watermark to the last item's `id`/`ts`, then run one turn so the
     agent produces an opening orientation message. Return `{ isNew: true }`.
  4. **Re-open:** compute the delta — items after `watermark_item_id` (fall back to
     `ts > watermark_ts`, or full re-seed if the watermark id is gone, e.g. the
     transcript rolled). If non-empty, record a `user` update message (below) and
     advance the watermark; do **not** auto-run a turn (the delta sits in context
     for the user's next message). Return `{ isNew: false }`.

### 3. Seed + update format (with markers)

Both are plain `user`-role messages (replayed by `historyAsLlm`, which already
emits user rows; consecutive user messages are merged by the provider).

Initial seed:
```
[BTW CONTEXT]
You were opened from a Podium chat session and your job is to help continue or
reason about it. You have tools — use `read_session_transcript` to pull the full
transcript (this is only a digest), `search_conversations`, `start_agent`, etc.

Session: <name> · <agentKind> · <cwd>  (session id: <sessionId>)
Caught up to item <lastItemId> at <lastTs>.

Summary: <stored conversation.summary, if any — else omit; you may summarize>

User's messages (every human turn, oldest→newest):
- [<ts>] <user text>
- ...

Recent activity (last ~20 items, tool results truncated):
- [<ts> · <id>] <role>: <text | toolName toolInput | result preview>
- ...
```

Re-open update:
```
[BTW UPDATE @ <now>]
Since you last looked (item <prevWatermarkId> at <prevWatermarkTs>), the user
continued this session. <N> new items:
- [<ts> · <id>] <role>: <text | toolName toolInput | result preview>
- ...
You are now caught up to item <newWatermarkId> at <newTs>.
```

Each line carries the item `id` and `ts` (both exist on `TranscriptItem`) so the
agent has positional + temporal awareness across re-opens.

**Budget:** seed targets ≤ ~20k tok. All user messages are included verbatim
(cheap). The tail is the last N items (N≈20) with each tool result truncated
(≈300 chars, matching `renderTranscriptItem`); the whole seed is char-capped and
trims the tail first if over budget.

### 4. Transcript tool upgrade

Replace the superagent's `read_transcript` tool (currently `registry.transcriptFor`
— live buffer only) with `read_session_transcript`, backed by the async
`registry.readTranscript({ sessionId })` so it reads disk for parked/exited
sessions too. Keep `lastN` (default 30, max 100) and the existing
`renderTranscriptItem` formatting.

### 5. API surface

`packages/protocol/src/messages.ts` + `apps/server/src/router.ts`:

- `superagent.listThreads()` → `[{ id, kind, originSessionId?, title?, updatedAt }]`
- `superagent.history({ threadId })`
- `superagent.send({ threadId, text })`
- `superagent.startBtw({ sessionId })` → `{ threadId, isNew }`
- `superagent.clear({ threadId })` (archive/clear a btw thread)

Existing single-thread endpoints become thin wrappers defaulting `threadId='global'`
for backward compatibility.

### 6. Web + native UI

`apps/web/src/AgentPanel.tsx`: add a **BTW button** in `agent-panel-bar`, directly
next to the archive button. Because the bar is shared above both the chat and the
native-terminal modes, one button covers both views. Unlike archive (hidden when
hibernated/exited), the BTW button stays visible for parked/exited sessions —
reading a finished transcript is a prime use case. Gate on `chatCapable` (needs a
transcript).

Click → `superagent.startBtw({ sessionId })` → reveal `SuperagentView` focused on
the returned `threadId`. `SuperagentView` (`apps/web/src/SuperagentView.tsx` +
`store.tsx`) gains a lightweight thread switcher (Global + btw threads, labeled by
origin session name).

## Data flow

```
[BTW button] → startBtw({sessionId})
  ├ new:   create thread → readTranscript → build seed (markers) → record user msg
  │        → run 1 turn (orientation) → return {threadId, isNew:true}
  └ reopen: readTranscript → delta since watermark → record update msg (markers)
           → advance watermark → return {threadId, isNew:false}
web: open SuperagentView on threadId; user continues the thread normally.
agent: pulls full transcript via read_session_transcript only when it needs detail.
```

## Testing

- `store.test.ts`: thread CRUD; migration backfills `global` + preserves existing
  messages; `thread_id` scoping of load/append/clear; watermark set/get.
- `superagent.test.ts` (new or extended): seed builder respects the token/char
  budget and truncates the tail first; markers (id + ts) present; delta computation
  (after-watermark, fallback to ts, full re-seed when id missing); `startBtw`
  new-vs-reopen branch.
- `router.test.ts`: new endpoints route to the service with the right thread id.
- Avoid agent-bridge integration + e2e/playwright suites (PTY leaks / can kill live
  agents). Verify with `vitest run apps/server packages/protocol` and `typecheck`.

## Cost summary

- Launch (new): ~$0.05–0.08 (seed input + small orientation output).
- Re-open: ~$0 (delta injected as context; no auto-run).
- Full transcript: ~$0.30–0.40, only if the agent calls `read_session_transcript`.
- Continuation turns: normal pricing (history window 40 rows).
