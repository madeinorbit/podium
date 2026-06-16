# Transcript classification: agent state & chat rendering

> **Audience:** a later agent (or human) working on Podium's chat view (`apps/web/src/ChatView.tsx`,
> `apps/web/src/chat.ts`), the transcript parser (`packages/agent-bridge/src/transcript/claude.ts`),
> or the agent-state detector (`packages/agent-bridge/src/agent-state/*`).
>
> **What this is:** a field guide to the markers in Claude Code's JSONL transcript that let us
> classify each record correctly — for the chat view AND the agent-state detector, which share the
> same source data. Everything here was derived empirically from ~12 real transcripts
> (`~/.claude/projects/*/*.jsonl`, ~3k assistant / ~1.4k user records) on 2026-06-16.

---

## 1. The two problems

1. **What is the user supposed to read?** An assistant turn emits several kinds of visible text:
   - **Final answer** — the message the agent ends its turn with (what a human reads).
   - **Intermediate narration** — "Let me check X…", "Strip fix merged…" between tool calls.
   - **Thinking** — extended-thinking blocks (reasoning, usually hidden/dimmed).

   We want to render the final answer as a prominent agent **chat bubble** and accent it in the
   birds-eye minimap; narration should read as secondary; thinking should be collapsible/hidden.

2. **What is a real user turn vs. harness-injected noise?** Not every `type:"user"` record is the
   user typing — see §3. This matters for the chat ("You" bubbles) *and* for the agent-state
   detector deciding whether the user actually acted.

---

## 2. Assistant records — final answer vs. narration vs. thinking

### The key marker: `message.stop_reason`

Every `type:"assistant"` record carries the parent API message's `stop_reason`:

| `stop_reason` | meaning | count (8 files) |
|---|---|---|
| `"tool_use"` | the assistant paused to call a tool — **more is coming** (intermediate) | 1607 |
| `"end_turn"` | the assistant **finished its turn** — waiting on the user (final) | 98 |
| `"stop_sequence"` | finished on a stop sequence — treat like `end_turn` | 2 |
| missing / `null` | rare (1/1708); treat as turn-final if no tool_use follows | 1 |

### Crucial structural fact: blocks are split across records

Claude Code writes **separate JSONL records per content-block group** within one API message, and
**each split record repeats the parent message's `stop_reason`**. Empirically, **no record contains
both a `text` block and a `tool_use` block** (0 occurrences). So a record is effectively one of:

- a `thinking`-only record,
- a `text`-only record (visible prose),
- a `tool_use`-only record (one or more tool calls).

Content-block type counts (8 files): `tool_use` 733, `thinking` 508, `text` 467.

### → Classification rule for visible assistant text

A `text` block's **own record's `stop_reason`** tells you which kind it is:

```
text block in a record with stop_reason "end_turn" (or "stop_sequence")  → FINAL ANSWER
text block in a record with stop_reason "tool_use"                       → INTERMEDIATE NARRATION
```

Verified by sampling: `end_turn` text = the agent's closing summaries to the user;
`tool_use` text = the "doing X now…" lines between tool calls. This is exactly the
"last text after the last tool call" the product wants to elevate.

Distribution of `text`-bearing records: `tool_use`/has-text = 412 (narration),
`end_turn`/has-text = 53 (answers). (A turn averages several narration lines and one answer.)

### Thinking

`thinking` blocks have shape `{ type:"thinking", thinking:"…", signature:"…" }` — the reasoning text
is in `.thinking` (sometimes empty/redacted, signature-only). **The current parser drops them**
(`assistantItems` in `claude.ts` only handles `b.type === "text"` and `b.type === "tool_use"`). If we
ever want a collapsed "thoughts" affordance, read `b.thinking` from `type:"thinking"` blocks.

### Edge cases

- **`end_turn` with no text (45 records):** the agent ended a turn whose last content was a tool
  result or thinking, with no closing prose. There is no "final answer" to elevate — fall back to
  showing nothing special (or the last narration).
- **Streaming / partial writes:** rely on `stop_reason`, not record ordering, to find the answer.
- **Older transcripts:** `stop_reason` has been present in everything sampled; if absent, treat a
  trailing assistant `text` record (no tool_use after it before the next user turn) as the answer.

### Buried intermediate answers have NO marker (investigated 2026-06-16)

Agents often answer a question **before** the turn ends — e.g. for the prompt
*"so the fixes have landed on main?"* the answer *"Yes — main is fast-forwarded to
adbd05f…"* was the **first** intermediate (`tool_use`) text block, with the
`end_turn` summary much later. These get missed because they're buried among
narration. We checked whether anything distinguishes a *substantive* intermediate
answer from thin narration:

- **No.** `text` content blocks are exactly `{type:"text", text}` — no flag. The
  record-level keys of an "answer" block and a "narration" block are identical
  (both `stop_reason:"tool_use"`).
- The only signals are **length** (weak — across 8 files, 208 intermediate text
  blocks fall in the ambiguous 80–250 char band, overlapping both classes) and
  **position** (the first text block after a user prompt is *often* the direct
  answer — but not reliably).

So **only the final answer is reliably markable** (`stop_reason`). For buried
answers the pragmatic mitigation shipped here is: the minimap draws **every**
agent-prose block in its own visible tone (distinct from tool steps), so buried
answers are at least *locatable* (hover shows a preview, click jumps). A
**lead-response heuristic** (elevate the first text block after each user prompt)
is a reasonable opt-in if false positives ("Let me check X…") are acceptable —
it'd be computed at the block level in `chat.ts` (which has turn context), not in
the per-record parser.

### Live vs. on-disk

`stop_reason` is the **on-disk** (transcript) signal. The **live** equivalent is the agent-state
detector's `Stop` hook → `turn_completed` → phase `idle`/`needs_user` (see §4). When the chat is
following a live tail, the same record gains `stop_reason:"end_turn"` the moment the turn lands.

---

## 3. User records — real prompt vs. injected vs. action

`type:"user"` is overloaded. The distinguishing fields (all on the record, not inside `message`):

| signal | value | meaning | handling (in `claude.ts`) |
|---|---|---|---|
| `isMeta` | `true` | skill-body/slash expansions, "Continue…", SessionStart context | **drop** |
| `promptSource` | `"system"` | harness-injected turn (task-notification, etc.); `origin.kind` names it | **drop** (string content) |
| `promptSource` | `"typed"` / `"queued"` | a **real** user prompt (typed, or queued while busy) | keep → role `user` |
| `message.content` | array w/ `tool_result` | tool output fed back to the model | keep → role `tool` |
| text == `[Request interrupted by user]` | — | a real user **action**, not a message | keep role `user`, set `event:"interrupt"` (render inline, not a bubble) |
| embedded `<system-reminder>…</system-reminder>` | — | injected context inside an otherwise-real turn | **strip the block**; drop the turn only if nothing real remains |

**Why `promptSource`, not content-sniffing:** real prompts can *contain* `<system-reminder>` (the
harness prepends/appends them — e.g. `"<system-reminder>Message sent at…</system-reminder>\nYes"`,
where the real prompt is "Yes"). Dropping by "starts with a wrapper tag" would delete real prompts.
Strip the wrapper, keep the remainder. Do **not** key off `!== "typed"` either — `queued` is real.

`promptSource` distribution (string-content user records, 12 files): `typed` 58, `system` 26, `queued` 1.

### Record types that are NOT conversation (drop them)

Newer Claude Code writes many bookkeeping record types alongside `user`/`assistant`/`system`. None
are conversational; the parser ignores all but `user`/`assistant`/`system`:

`attachment` (file/image payloads — the user msg already references them as image/file *tags*),
`bridge-session`, `mode`, `permission-mode`, `ai-title`, `last-prompt`, `file-history-snapshot`,
`worktree-state`, `agent-color`, `queue-operation`.

- **`queue-operation`** (`{operation:"enqueue"|"dequeue", content}`) carries text but is a queue
  *event*; the queued prompt re-appears as its own `promptSource:"queued"` user record on submit, so
  dropping the queue-operation avoids double-showing it.

---

## 4. The agent-state detector (shared concern)

`packages/agent-bridge/src/agent-state/` is currently **hook-driven**, not transcript-driven
(`claudeHookSettings` subscribes SessionStart / UserPromptSubmit / Pre/PostToolUse / Permission /
Stop / StopFailure / Compact / Task* / SessionEnd; `translateClaudeHookPayload` maps them to events;
`reducer.ts` runs the phase machine: `prompt_submitted`→`working`, `turn_completed`→`idle`/`needs_user`, …).

**Open parallel risk (unverified):** `UserPromptSubmit` → `prompt_submitted` → `working`
unconditionally, and the hook handler does **not** consume `promptSource`. If Claude Code fires
`UserPromptSubmit` for *injected* turns (task-notifications / `promptSource:"system"`), the agent
would flip to `working` (and reset `since`) on a non-user event — the same misclassification we fixed
in the transcript. **To verify:** capture a real `UserPromptSubmit` hook payload during a background
task-notification injection and check (a) whether the hook fires at all and (b) whether the payload
carries `promptSource`. If it does, apply the same guard (treat `promptSource:"system"` as `activity`,
not `prompt_submitted`). Impact may be benign (the agent genuinely processes injected turns), so
confirm before patching.

**Why this doc lives here:** the answer-vs-narration signal (`stop_reason`) is also useful to
agent-state — e.g. an `end_turn` text that reads like a question is the basis for the
`idle{kind:"question"}` verdict (`classifyIdleFromStop`). Keep the transcript classification and the
state classification using the *same* taxonomy.

---

## 5. Implementation notes (for the chat-bubble / minimap feature)

**Status:** the final-answer path (1–3 below) shipped 2026-06-16 — parser sets
`TranscriptItem.answer`, the chat renders an "Answer" bubble, and the minimap
accents it (emerald) with intermediate agent prose in its own tone. Thinking (4)
and the lead-response heuristic remain open.

The data needed already exists; the parser just isn't surfacing it. Shape:

1. **Parser** (`claude.ts` `assistantItems`): thread `message.stop_reason` in and tag the produced
   assistant item, e.g. add an optional `TranscriptItem` field
   `answer?: boolean` (true when `stop_reason ∈ {end_turn, stop_sequence}` and the record has text),
   or a more general `turn?: "final" | "intermediate"`. (Mirror the existing `event:"interrupt"`
   pattern — a presentation hint that does **not** change `role`.)
2. **Chat view** (`ChatView.tsx`): render `role:"assistant"` + `answer` as a distinct agent **chat
   bubble**; render intermediate narration as the current lighter style. Optionally fold consecutive
   narration under the answer.
3. **Minimap** (`chat.ts` `minimapSegments` + `ChatView` `Minimap`): give final-answer segments their
   own tone (today only `role:"user"` gets the accent; add an accent for `answer` assistant items).
4. **Thinking** (optional): emit `type:"thinking"` blocks as a collapsed item rather than dropping
   them, if a "show thoughts" affordance is wanted.

### Don'ts

- Don't infer "final" from record position/ordering — use `stop_reason`.
- Don't reclassify `role` to express presentation; add a hint field (like `event`/`answer`) and let
  the renderer decide. The role must stay semantically true for the state detector and the /btw seed,
  which share this parser.

---

## 6. Quick reference — marker → classification

```
RECORD type:"assistant"
  block type "thinking"                         → thinking (currently dropped; read .thinking)
  block type "text",  stop_reason end_turn/stop_sequence → FINAL ANSWER  (elevate: bubble + minimap accent)
  block type "text",  stop_reason tool_use      → intermediate narration (secondary)
  block type "tool_use"                          → tool call (role "tool")

RECORD type:"user"
  isMeta:true                                    → drop
  promptSource:"system"  (string content)        → drop (injected: task-notification, …)
  content has tool_result                        → role "tool"
  text == "[Request interrupted by user]"        → role "user" + event:"interrupt" (inline, not a bubble)
  <system-reminder>…</system-reminder> inside    → strip block; drop iff nothing real remains
  promptSource:"typed"/"queued" (or absent)      → role "user" (real prompt)

RECORD type:"system"                             → role "system"
RECORD any other type                            → drop (bookkeeping: attachment, mode, queue-operation, …)
```

**Source of truth:** `packages/agent-bridge/src/transcript/claude.ts` (parser) and
`packages/agent-bridge/src/transcript/claude.test.ts` (locks each rule above with a fixture).
