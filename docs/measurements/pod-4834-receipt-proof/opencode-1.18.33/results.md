# OpenCode 1.18.33 — what it reports when it takes a message (run 2026-09-29)

Lane of POD-4834 for Phase B of POD-4720 (spec `docs/plans/pod-4819-harness-receipt-proof.md`).
Every fact below was **run** on the real binaries, by the method of `../README.md`. Where a fact
rests on one run only, it says so.

- **HTTP v1** — `opencode serve` 1.18.33: `POST /session/{id}/prompt_async`, `GET /event`.
- **HTTP v2** — 1.18.33 serves the v2 `/api` surface too (`POST /api/session/{id}/prompt`,
  `GET /api/event`, `GET /api/session/{id}/event?after=`). Measured on 1.18.33, and — because the
  `opencode2` driver only admits preview builds — again on the installed
  `opencode2` **0.0.0-beta-18866** (not installed for this lane; it was already on the machine).
  The two builds differ (see "v2: 1.18.33 and beta-18866 differ").
- **Terminal UI** — `opencode --port 47871` (1.18.33) in a 180×45 tmux pane.

## Setup

Scratch `HOME` / `XDG_*` dirs, no credentials, `OPENCODE_DISABLE_AUTOUPDATE=1`,
`OPENCODE_DISABLE_MODELS_FETCH=1`. Model: a local fake OpenAI chat-completions server
(`harness/fake-openai.ts`, provider `fake` via `@ai-sdk/openai-compatible`, dummy key) that logs
every request with its **full messages**. A prompt containing `TOOLSLEEP` gets one shell tool call
`sleep 8` (`bash` on 1.18.33, `shell` on the beta); `SLOWTEXT` gets 20 words over 10 s; `MODEL400`
gets an HTTP 400. `harness/opencode.json` is the work dir config (the TUI part added
`enabled_providers: ["fake"]`, see "Limits").

Logged, each with its receive time, into one timeline per run:
- every HTTP request we sent and its reply (status, body, ms);
- every SSE frame of `GET /event` (v1 and TUI) and `GET /api/event` + `GET /api/session/{id}/event?after=0` (v2);
- **every** plugin hook of `@opencode-ai/plugin` 1.18.33 (`harness/hooklog-plugin.ts`: `event`,
  `config`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`,
  `command.execute.before`, `tool.execute.before/after`, `shell.env`, all `experimental.*`,
  `tool.definition`, `dispose`). OpenCode has no shell hooks; plugins are its hook system.
- every insert, update and **delete** of the history tables in SQLite (`message`, `part`,
  `session_input`, `session_message`, `event`; beta: `session_inbox`, `session_pending`),
  polled every 25 ms and logged in rowid (insert) order — so DB times carry up to ~25 ms lag;
- every append to the TUI's state files (`prompt-history.jsonl`, `model.json`, …);
- every model request (`model-requests*.jsonl`, full messages; the system prompt is replaced by its length).

Times are **ms after the send** (HTTP request start, or the Enter keystroke in the TUI).
`harness/signals.ts` extracts the per-send table mechanically (`*/signals-auto.md`); the numbers
below were checked against the timelines by hand (the automatic table mis-attributes repeats and
the TUI's two-source sends).

Evidence: `v1/`, `v2/`, `v2-beta-18866/`, `tui/` (each `timeline*.jsonl`, `model-requests*.jsonl`);
`harness/` holds every script. Reproduce: `bun harness/v1.ts <out> s1 s1w s2 s3 s4 s5 s7 s10 s6`,
`bun harness/v2.ts <out> s1 s2 s3 s4 s5 s5p s7 s10 s6 s6e` (beta: `OC_BIN=opencode2 V2SHAPE=beta`),
TUI: `harness/tui-watch.ts` + `harness/tui.sh`.

---

## HTTP v1 — `POST /session/{id}/prompt_async` with `messageID` + text part `id` (ours)

Our ids: `messageID = msg_<uuid>`, text part `id = prt_000000000000<uuid>` (the driver's shape).
Signals: **204** (reply) · **`chat.message`** hook (`input.messageID` = ours) · **message row** /
SSE `message.updated` (user, our id) · **text part row** / SSE `message.part.updated` (our part id,
the text) · model request.

| Scenario | 204 | `chat.message` (our id) | user message row (our id) | text part (our part id) | model request | Accepted / confirmed |
|---|---|---|---|---|---|---|
| S1 idle, first prompt of a fresh server (`v1/timeline.jsonl` S1) | +25 | +222 | +263 | **+2 202** | +4 723 | 204 before anything is stored |
| S1w idle, warm (S1w) | +18 | +17 | +25 | +58 | +238 | text part = in history |
| S2 busy in a tool (S2.B) | +355 | +352 | +364 | +395 | +8 182 — the next model call after the tool result, same loop | stored at once |
| S3 busy streaming text (S3.B) | +43 | +19 | +38 | +39 | +8 280 — next step after the text step | stored at once |
| S4 interrupt, then send | B stored +107/+158 while busy; `POST /abort` → `session.error MessageAbortedError`, idle; B **not run**. C: model +242, request holds B then C | — | — | — | — | B stays in history, unanswered |

SSE `message.updated`/`message.part.updated` frames arrive with the rows (warm: +59); on the cold
server they came +2 317. `session.status busy`, `session.idle` name no message.

- **No `accepted` signal distinct from `confirmed`.** A message sent while busy is stored (text part
  with our id) within ~40–400 ms, like an idle one; OpenCode v1 has no queue outside the history.
- **The 204 is not proof of anything.** It came before the hook and the rows every time, and a
  SIGKILL 67 ms after a 204 (idle send S6.C: 204 +126, kill +193) **lost the message**: no row, no
  hook, nothing after restart (one run).
- **The message row can exist without its text for ~2 s** (cold S1: row +263, part +2 202).
  Confirmation must key on the text part, not the message row.

### v1 — other scenarios

| # | What | Result | Evidence |
|---|---|---|---|
| S5a | same `messageID` + same part `id` + same text, after the turn ended | 204 +72; `chat.message` fires again (our id); message/part rows **updated in place**, nothing new; a busy→idle blip + `session.idle`; **no model call, no assistant message** (the "empty turn" of POD-4813 = this blip) | `v1/timeline.jsonl` S5a |
| S5b | same `messageID`, **no part id** (OpenCode mints one) | a **second text part** is added to the same message; the next model request carries the text twice | S5b |
| S5c | same ids twice at once | two 204s, one message, one part, one turn | S5c |
| S5d | same ids, **different text** | 204; the stored text part is **overwritten** with the new text (history rewritten after the model saw the old text); no turn | S5d |
| S10 cross | our id already used in **another** session | 204; nothing in this session; **the other session's message text is overwritten**; this session gets `session.error UnknownError "No user message found in stream"` | S10.cross |
| S6 busy | B stored behind a tool, SIGKILL 208 ms after B's send, restart | B survives (text); **not run** after restart (15 s, status idle); reaches the model with the next prompt | S6.B/S6.D |
| S6 idle | 204 +126, SIGKILL +193 | **lost** (no row) | S6.C |
| S6 recovery | stranded B (stored, unanswered) + restart + **resend of B's same ids** | 204, one record, the loop runs B once (model +5 120, cold server) | `v1/timeline-recovery.jsonl` |
| S7 | leading/trailing spaces+tab, `\n\n`, CRLF, unicode (combining mark, RTL, emoji, ZWSP), 16 897-char text | stored part, hook text and model text **byte-identical** to what we sent | `harness/s7check.ts` |
| S8 | timestamps | `message.time.created` = ms, set when the server handles the request (S1w: 11 ms after the send, 14 ms before the row write); the text part's `time_created` = when the part is written (cold S1: 1.8 s later). No field records the write of the message row. | S1, S1w |
| S10 | 400 (id not `^msg`), 400 (bad part type), 404 (unknown session) | error reply, **nothing recorded**, no hook | S10 |

---

## HTTP v2 on 1.18.33 — `POST /api/session/{id}/prompt {id, prompt:{text}, delivery}`

Signals: **200** with `data {admittedSeq, id (ours), sessionID, prompt, delivery, timeCreated[, promotedSeq]}` ·
**`session.next.prompt.admitted`** (`messageID` = ours; on `/api/event` and the durable
`/api/session/{id}/event`) · **`session_input` row** (`admitted_seq`) ·
**`session.next.prompted`** (ours) · `session_input.promoted_seq` set + **`session_message` user row**
(our id, `seq`) · model request. `GET /api/session/{id}/message` lists the input only after
`prompted`.

| Scenario | 200 | admitted event / row | prompted event / user row | model request | Accepted / confirmed |
|---|---|---|---|---|---|
| S1 idle `queue`, first prompt (S1) | +2 214 | +2 150 / +2 190 | +2 342 / +2 373 | +2 484 | 200 = accepted, prompted = confirmed |
| idle `queue`, warm (S2queue.A) | +24 | +11 / +34 | +66 / +64 | +127 | |
| idle `steer` (S1s) | +105 | +105 / +94 | **same instant** +105 / +94 | +334 | |
| S2 busy in a tool, `queue` (S2queue.B) | +29 | +29 / +26 | **+6 438** — after the whole turn (tool step and the text step after it) | +6 548, a new turn | accepted for 6.4 s |
| S2 busy in a tool, `steer` (S2steer.B) | +11 | +11 / +34 | **+5 960** — at the end of the tool step | +6 101, next step of the same turn | |
| S3 busy streaming, `queue` (S3queue.B) | +38 | +54 / +42 | +7 444 (turn end) | +7 853 | |
| S3 busy streaming, `steer` (S3steer.B) | +34 | +33 / +72 | +7 622 (step end = turn end) | +7 768 | |
| S4 interrupt after a pending `queue`/`steer` B | +26 / +19 | admitted | **not promoted by the interrupt**; session idle (`/api/session/active` empty 3.3 s after the interrupt); promoted only when the next prompt C arrives (+4 326 / +4 476 after B), run as its own turn before C | +4 482 / +4 630 | accepted indefinitely |

The DB row times carry the 25 ms poll lag; the admitted **event** arrived within about 20 ms of
the 200, before or after it.

### v2 (1.18.33) — other scenarios

| # | What | Result | Evidence |
|---|---|---|---|
| S5 | same id + same text after the turn ended | 200 with the **original admission** (`admittedSeq` 1, `promotedSeq` 2); no record, no event, no turn | `v2/timeline.jsonl` S5a |
| S5 | same id + **different text** after the turn | **409** `ConflictError` "Prompt message ID conflicts with an existing durable record" | S5d |
| S5 | same id + same text while the first is **pending** | 200 original admission (`admittedSeq` 7), one record | `v2/timeline-pending-repeat-and-recovery.jsonl` S5p |
| S5 | same id + different text while pending | **409** | S5e |
| S5 | same id twice at once | two 200s, one record, one turn | S5c |
| S5 | id already used in **another session** | **409** (not "that session's input") | S5f |
| S6 | idle send, **SIGKILL at the 200** (0 ms after; process gone 158 ms later), restart | the `session_input` row **survived**; not in `/message`; **not run** after restart (12 s idle); promoted and run first when the next prompt arrived 21 s later. **Admission is durable** (one run per build). | S6a |
| S6 | busy, `queue` B, SIGKILL at B's 200, restart | same: survived, pending, run when a later prompt arrived | S6b |
| S6 | recovery: pending input after a kill + restart, **resend the same id** | 200 original admission, and the resend **starts it**: prompted +134, model +227. A later `resume: true` repeat: 200, nothing new | `…pending-repeat-and-recovery.jsonl` S6e |
| S6 | same id again after two restarts | 200 original admission, no turn | S6d |
| S7 | same texts as v1 | admission, stored input, user row and model text **identical** | s7check |
| S8 | timestamps | `timeCreated` / `session_input.time_created` / user row `time.created` = **admission** time (ms); user row `time_updated` = promotion time; `session.next.prompted.timestamp` = admission time (also after a restart) | S2queue.B, S6e |
| S10 | 400 (id not `^msg_`), 400 (bad `delivery`), 400 (the beta body shape `{id,text,delivery}`: "Missing key prompt"), 404 (unknown session) | nothing recorded | S10 |
| hooks | a v2 prompt fires **no** `chat.message`/`chat.params`; only the generic `event` hook with `session.next.*` types — and only if a v1-routed call loaded the plugin first (a pure v2 run logged **zero** hook lines, not even `plugin.init`) | `v2/hooks-probe-timeline.jsonl` |
| stores | v1 `GET /session/{id}/message` of a v2 session returns `[]`; v2 sessions live in `session_input`/`session_message`, v1 in `message`/`part` | hooks probe |

## HTTP v2 on beta-18866 — `POST /api/session/{id}/prompt {id, text, delivery}` (Basic auth)

Signals: **200** `data {id (ours), sessionID, timeCreated, type:"user", payload:{text}, delivery}`
(no seq) · **`session.inbox.enqueued`** (`inboxID` = ours) · `session_inbox` row · **`session.inbox.delivered`**
(ours) · inbox row **deleted** + `session_message` user row (our id) · model request. No per-session
event endpoint (`/api/session/{id}/event` → 404).

| Scenario | 200 | enqueued event / inbox row | delivered event / user row | model request |
|---|---|---|---|---|
| S1 idle `queue`, first prompt | +515 | +517 / +514 | +2 098 / +1 979 | +2 218 |
| idle `queue`, warm (S2queue.A) | +24 | +119 / +23 | +119 / +99 | +174 |
| S2 busy tool `queue` | +37 | +36 / +40 | +6 357 (turn end) | +6 398 |
| S2 busy tool `steer` | +43 | +42 / +91 | +5 844 (tool step end) | +5 900 |
| S3 busy text `queue` / `steer` | +68 / +44 | +69 / +48 | +7 242 / +7 247 | +7 280 / +7 265 |
| S4 interrupt, pending B | +22 / +14 | enqueued | not delivered by the interrupt (`session.execution.interrupted`); delivered when C arrives | +4 115 / +4 140 |

| # | What | Result |
|---|---|---|
| S5 | same id, same text, after done | 200, the original (first) record |
| S5 | same id, **different text**, after done **and** while pending | **200 with the original (first text)** — POD-4813's claim holds on the beta |
| S5 | same id at once / pending same text | one record |
| S5 | id used in another session | **409** |
| S6 | SIGKILL at the 200 (idle), and at a busy B's 200 | inbox row survived; pending, not run; delivered when a later prompt came |
| S6 | recovery: resend the same id after restart | 200 original, delivered +1 041, model +1 269 (`v2-beta-18866/timeline-recovery.jsonl`) |
| S7 | same texts | identical |
| S8 | timestamps | user row `time.created` = **delivery** time (S2queue.B: admission 1790699509641, row 1790699515963); after delivery the admission answer's `timeCreated` is the delivery time too (S6d) |
| S10 | 400 bad id, 400 bad `delivery`, 404 unknown session | nothing recorded |

### v2: 1.18.33 and beta-18866 differ

- **Body**: 1.18.33 `{id, prompt:{text, files}, delivery}`; beta `{id, text, files, delivery}`. The
  `opencode2` client's body is **refused by 1.18.33** (400 "Missing key prompt").
- **Answer**: 1.18.33 carries `admittedSeq`/`promotedSeq`; beta has neither.
- **Different text under a known id**: 1.18.33 **409**; beta 200 with the original.
- **Events/tables**: `session.next.prompt.admitted`/`prompted` + `session_input` (kept) vs
  `session.inbox.enqueued`/`delivered` + `session_inbox` (row deleted on delivery).
- **User row time**: admission time vs delivery time.

---

## Terminal UI — `opencode --port 47871` (1.18.33)

The TUI talks to its own in-process server over the v1 routes; OpenCode mints every id.
Signals: **`prompt-history.jsonl`** line `{input, parts, mode}` (no id, no time) · **`chat.message`**
hook (`input` has **no** `messageID`; `output.message.id` = OpenCode's) · user **message row** +
**text part** (OpenCode ids `msg_0ee…`/`prt_0ee…`) · SSE `message.updated`/`part.updated` on the TUI's
server · model request.

| Scenario | prompt-history line | `chat.message` | user row / text part | model request | Accepted / confirmed |
|---|---|---|---|---|---|
| S1 idle, first prompt | +134 | +199 | +227 / +227 | +4 250 (a title request went first) | text part = in history |
| idle, warm (S4.enterA) | +45 | +27 | +50 / +50 | +251 | |
| S2 busy in a tool (S2.enterB) | +67 | +31 | +41 / +68; screen shows it **QUEUED** | +6 244, next step after the tool | stored at once despite "QUEUED" |
| S3 busy streaming (S3.enterB) | +47 | +58 | +82 / +82 | +7 798 | |
| S4 Esc Esc after a queued B | B stored +65; interrupt → `session.error MessageAbortedError`, **no user entry** from the interrupt; B not run | | | C: +346, request holds B then C | |

### TUI — other scenarios

| # | What | Result | Evidence |
|---|---|---|---|
| S5 | the same text submitted twice | **two** user messages (different ids), both in the model request; **one** prompt-history line (a repeat of the previous line is not written) | `tui/timeline.jsonl` S5, `tui/prompt-history.jsonl` |
| S6 | busy-queued B, SIGKILL 210 ms after Enter, restart `-s` | B survived with its text, shown QUEUED; the killed tool still shows as running; **nothing ran** for 20 s; the next prompt's request held B | S6a |
| S6 | idle submit, SIGKILL ~45 ms after Enter | survived with text; not run after restart; went out with the next prompt | S6b |
| S6 | idle submit, SIGKILL ~35 ms after Enter | a user message row **with no parts** survived (API: `parts: []`); the prompt-history line survived **with** the text; the next model request **left it out** — the text is lost | S6c, `tui/session-history-final.json` row 50 |
| S7 | typed text (leading/trailing spaces, unicode) | identical, except that the combining accent (U+0301) typed via tmux landed after the next character — cause (tmux or OpenCode) not isolated; typing is Phase D | S7 |
| S7 | bracketed paste | box and prompt history show `[Pasted ~N lines] ` (text in `parts`); the stored text is the pasted text **with a trailing space added** (4-line paste: the final `\n` became a space; 16 902-char one-line paste: a space appended) | S7.ml, S7.long |
| S8 | timestamps | `message.time.created` = ms when the server handled the submit (S1: +195; row write +227); prompt history has none | S1 |
| S9 | keyboard Enter and an HTTP `prompt_async` (our id) 10 ms apart, idle and busy, both orders | separate user messages **in arrival order** every time; two queued inputs stay two user messages in one model request (**no merging**); the HTTP message never appears in prompt history | S9a–S9c |
| S9 | `/compact` | a **user-role message with one `compaction` part and no text** (OpenCode id), no `chat.message`, no prompt-history line, `session.compacted` event | S9.compact |
| S9 | custom command `/probe hello args` | prompt history keeps `/probe hello args`; the stored user text is the **expanded template** (`S9 CMD TEMPLATE expanded with: hello args`); hooks `command.execute.before` + `chat.message`; event `command.executed` (its `messageID` is the assistant reply's) | S9.cmd |
| S10 | the model answers 400 | the user message stays in history; the assistant message carries the error; `session.error APIError` | S10 |
| S10 | error reply to a request | not applicable: nothing between us and the TUI has a reply (keystrokes) | — |

---

## CONTRADICTS OR EXTENDS THE SPEC

**§4 statuses**
- v1 / TUI: the only program signals are the `chat.message` hook (in-process plugin), then the
  message row, then the **text part**. There is no separate `accepted` state: a message sent while
  busy is in history at once. The v1 **204 is not `accepted`**: a kill 67 ms after it lost the
  message (one run). Confirm on the **text part** (our part id on v1), never on the message row —
  the row existed ~2 s without text (cold S1) and survived a kill with no text at all (TUI S6c).
- v2 (both builds): **200 admission = `accepted`, durable** (survived a SIGKILL at the 200, one run
  per build); `session.next.prompted` / `session.inbox.delivered` + the user row = `confirmed`.
- **`accepted` can last forever.** After an interrupt or a restart, a pending v2 input is promoted
  only when another prompt arrives or its id is resent. A timer moving it to `unknown` would be
  wrong while a resend under the same id is available (and recovers it — §3.8 below).
- **Extends "Delivered"**: v1/TUI messages stored while busy and then stranded by an interrupt
  or a crash are in history (confirmed) but **unanswered until something starts a turn**. "The model
  reads it at its next step" holds only once a next step happens.

**§5.1** v1 takes our `messageID` and part id (both echoed in hook, events, rows); v2 takes our id
(admission, events, rows); the TUI takes none — order plus text only.

**§5.2 position** — v1/TUI: SQLite rowid order is insert order; `time.created` is the receipt time in
ms, written before the row. v2 1.18.33 has a per-session sequence (`admittedSeq`, `promotedSeq`,
`session_message.seq`, and a replayable event log `GET /api/session/{id}/event?after=<seq>`) — a
natural position. The beta has `seq` on rows but no replayable event endpoint, and its user-row
time is the delivery time.

**§5.3 preconditions (terminal)**
- History order = submit order: **run, holds** (3 cases, keyboard vs HTTP 10 ms apart, idle and busy).
- Every prompt entry comes from a submit: **run, does not hold** — `/compact` writes a text-less
  user message; a custom command writes its expanded template; a crash can leave a text-less user
  message; messages sent over HTTP into the TUI's session are user entries nobody typed.
  A reader must drop user messages without a text part and treat command expansions as not typed.
- Text tolerance: typed text identical; **paste adds a trailing space** (a final newline becomes it);
  commands are expanded. Merging: **none observed**.
- `prompt-history.jsonl` is **not** a submit record: no id, no time, skips a repeated identical
  submit, stores paste placeholders, keeps a line whose text never reached history.

**§6.1 N2** — v1 and v2 400/404 replies recorded nothing (run). But a v2 **409 means the id is
already recorded** (other text, or another session) — it must not count as "not recorded". Model
errors never come back as a reply to our request; they arrive later as `session.error`, and the
prompt stays in history.

**§6.1 N3** — v2: "no turn open" (`/api/session/active` empty) while an admitted input is pending
(after an interrupt, after a restart): **"no turn open" does not mean it holds no copy**. v2
deduplicates, so N3 is not needed there. v1: idle + no record after a 204 did mean lost (one run).

**§6.1 N4** — v1: holds for the lost case (nothing survived). TUI: a text-less user message
survives a kill; it must count as "nothing" (it never reaches the model). **v2: does not hold if
"history" means the message list** — the admitted input survives outside it and is delivered
later. A v2 reader must include pending admissions (`session_input` / `session_inbox`, or the
event log).

**§3.8 resend under the same id** — run on all three HTTP surfaces:
- v2 1.18.33 and beta: a repeat never records twice and returns the original admission; after a
  kill, **a resend starts the stranded input**. On 1.18.33 the resend must carry the **same text**
  (a different text → 409); the beta answers 200 with the original either way.
- v1: idempotent only with **both** ids fixed and the **same** text: a different text
  **overwrites** the stored text; without a fixed part id the text is added twice; an id from
  another session overwrites that session's text. A resend of a stranded message runs it once.

**§7 rows (proposed text)**
- *OpenCode · HTTP v2*: run 1.18.33 and beta-18866 — admission under our id, durable at the 200;
  repeat returns the original (1.18.33: 409 on different text; beta: original); `prompted` /
  `inbox.delivered` = in history (queue: at turn end; steer: at step end); pending survives
  interrupt and restart unrun, resend starts it. Decisions: `accepted` on the 200, `confirmed` on
  prompted/delivered, recovery = resend same id and same text; N3/N4 only with pending admissions read.
- *OpenCode · HTTP v1*: run 1.18.33 — 204 before storage (a kill after it lost the message); text
  part with our part id = confirmed within ~40–400 ms, busy or idle (cold server: 2.2 s);
  repeat with fixed ids records nothing new and runs a busy→idle blip; different text rewrites
  history. Decisions: `confirmed` on the part, no `accepted`; resend same ids + same text.
- *OpenCode · terminal*: run 1.18.33 — OpenCode ids only; text part within ~30–230 ms busy or idle;
  order preserved, no merging; non-typed user entries exist (compaction, command expansion,
  crash half-records, HTTP-injected); paste appends a space. Decisions: order plus text with those
  filters; prompt history unusable as proof.

**Driver facts found on the way** (not spec sections): the `opencode2` client body is refused by
1.18.33's `/api` (400); the driver's comment "an id already admitted to another session answers
with THAT session's input" did not hold on either build (409, for an id already delivered);
v2 prompts fire no `chat.message` hook.

## Limits

- One run per kill case (v1 S6.C, v2 S6a/S6e per build, TUI S6a–S6c); kill timing relative to the
  program's internal write is uncontrolled beyond what is stated.
- DB rows are polled every 25 ms; row times can lag the write by that much.
- The first prompt of each fresh server is slow (plugin/provider start); warm numbers are separate rows.
- Not measured: attachments/files, `delivery: steer` into a multi-step turn with more than one tool
  call, `/api/session/{id}/wait`, compaction triggered automatically by context overflow,
  subagent (task) notifications, permission prompts (all tools were allowed).
- During the TUI S6 restarts one restart was launched in the wrong directory by my script (the TUI
  then offered OpenCode Zen models); nothing was submitted there, and the S6 results come from the
  correctly started runs. `enabled_providers: ["fake"]` was added to the config afterwards.


## Expanded input storage (2026-09-30, POD-4984)

[Corpus, exact bytes, method and reader follow-ups](../expanded-input/README.md).
Every shape is measured plain and framed: 2/10/200 lines, 1/16/100 KiB single lines,
three tabs, two CRLF separators, and a final LF. Both installed builds are pinned:
**1.18.33** and **0.0.0-beta-18866**. No real credentials or production reader changes.

| Path | Native storage and text | Evidence |
|---|---|---|
| HTTP v1 1.18.33 | One user text part per input, byte-exact through 100 KiB; our message and part ids survive | [v1 table](../expanded-input/opencode-v1/results.md) |
| HTTP v2 1.18.33 | Admission plus one `session_message` user row, byte-exact; our id survives | [stable v2 table](../expanded-input/opencode-v2/results.md) |
| HTTP v2 beta-18866 | One delivered user row, byte-exact; our id survives (pending inbox consumed) | [beta v2 table](../expanded-input/opencode2-v2/results.md) |
| Terminal 1.18.33 | One full user text part when submitted. Most pastes add SP; pasted CRLF → LF. Unbracketed tabs disappear and CRLF → LF. Frames in every stored prompt remain valid | [paste/key table](../expanded-input/opencode-terminal/results.md), [bounded typing](../expanded-input/opencode-terminal-paced/results.md) |
| Terminal beta-18866 | Same measured paste/control forms and full text parts. Standalone terminal uses its supported `--standalone --auto` entry point | [paste/key table](../expanded-input/opencode2-terminal/results.md), [bounded typing](../expanded-input/opencode2-terminal-paced/results.md) |
| Literal startup `--prompt` | Separate storage probe through the same native user rows; does not establish keyboard ingestion. Stable submitted 16/18 automatically, byte-exact; its CRLF cases stayed in the editor with no record within 48 s. Beta prefills and needs Enter: 18/18 recorded, CRLF → LF, other bytes exact | [stable startup](../expanded-input/opencode-terminal-initial/results.md), [beta startup](../expanded-input/opencode2-terminal-initial/results.md) |

Pastes of 200 lines and 100 KiB produce full native text, one part, without a wrapper,
truncation or split prompt. The UI/edit history can use `[Pasted ~N lines] `, while preserving
all pasted text in `parts[]` (stable) or `pasted[]` (beta). Those exact auxiliary history
objects are in [stable](../expanded-input/opencode-terminal/auxiliary-history.jsonl) and
[beta](../expanded-input/opencode2-terminal/auxiliary-history.jsonl); they are not the
conversation proof text. A two-line plain paste stayed literal in the measured edit history.
The plain final-LF case also stayed exact (46 B) in both builds; its framed paste gained SP
(190→191 B). The earlier short-prompt ending-LF-to-SP observation is not universal.

**POD-5004 — OpenCode terminal text matching** covers internal CRLF normalization and
unbracketed tab removal. The current matcher already accepts exact text and the ending-space
form, but misses these additional control-byte forms. API text stays byte-exact.
The large unbracketed cases can remain in the editor with no prompt record inside the stated
drain/submit window; those observations are listed explicitly, not called history truncation.
The final 100 KiB key-chunk observations lasted 538–539 s before submit attempts, with no
visible editor tail or native prompt. **POD-5011 — Long terminal input drain** keeps this
separate boundary discovery in Proposed.
