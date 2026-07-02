# Orchestrator Agents — evaluation, vision, and missing primitives

> Design/vision doc for issue #10 (Orchestrator Agents), 2026-07-02.
> Inputs: Gas Town (Yegge, v1.0 posts), Orca's orchestration skill, our own
> `docs/orca-hermes-openclaw-harness-analysis.md`, `docs/SPEC.md` §5.3, and
> `docs/superpowers/specs/2026-07-01-issues-in-agents-design.md` (§12, §19).

## 1. Goal

Make Podium autonomous between human touches. Today every forward step —
starting ready work, unblocking dependents when a blocker closes, checking in
on an idle agent, tidying the tracker, briefing the user when a question
lands — requires the human to notice and act. We want an orchestrator layer
that is **woken by events**, keeps work flowing, keeps the issue tracker
truthful, and packages context so the human can re-enter cheaply.

Companion product vision: the user always starts with an agent — a big
context-aware **+ button** they type a wish into. That agent finds or creates
the right epic/issues, kicks off work, and later elicits artifacts from
working agents so the user can jump back in without deep context switching.

## 2. What the other systems do

### Gas Town (Steve Yegge)

An orchestration layer over 20–30 parallel Claude Code instances, state in
git. The relevant machinery:

- **Roles.** *Mayor* — the concierge the human talks to; files work, slings
  it, receives completion notices. *Deacon* — a daemon-driven agent that gets
  a "Do Your Job" heartbeat every couple of minutes and propagates it down.
  *Witness* — patrols worker swarms and unsticks blocked/stalled workers.
  *Refinery* — serializes the merge queue. *Polecats* — ephemeral one-task
  workers, decommissioned after merge. *Dogs* — maintenance chores; one
  special dog wakes every 5 minutes just to check the Deacon's health.
- **Work substrate.** *Beads*: git-backed issues (Podium's tracker is
  beads-parity, so we already have this). *Convoys*: a tracking wrapper
  around a batch of issues for delivery visibility. *Molecules/formulas*:
  templated multi-step workflows.
- **Propulsion.** GUPP — "if there is work on your hook, YOU MUST RUN IT" —
  plus the *nudge*: a tmux message fired ~30–60s after agent startup, because
  harness agents politely wait for input. Patrols run in loops with
  exponential backoff; any mutating command wakes the town.
- **Continuity.** *Handoff* (agent re-slings remaining work to its successor
  and restarts) and *seance* (resume a predecessor session via the harness's
  native `/resume` to interrogate it).
- **v1.0 lesson.** The retrospective's headline: the Mayor mattered because
  **users wanted someone to talk to while the system worked** — the concierge
  is a UX discovery, not an orchestration mechanism. Second lesson: the
  external work memory (beads) is what makes everything else possible.

### Orca (stably)

Orca ships orchestration as a **skill handed to an ordinary coordinator
session**, not a resident service: decompose a spec into parallel subtasks
with dependencies; dispatch to other terminals (each in its own worktree);
send messages between terminals; wait for completion signals. A DAG
auto-promotes tasks to ready when dependencies finish. Two details worth
copying: a **clear handoff model** so stale cross-worktree completions don't
confuse unrelated coordinators, and **decision gates** — explicit human
checkpoints injectable into otherwise-automatic flows. Orca's state detection
doctrine ("authoritative hooks; everything else is enrichment") we already
follow.

### Hermes / OpenClaw (context)

Both own their inference loop, so their "orchestration" is internal (cron,
proactive turns, commitment extraction). Two datapoints matter for us:
cron-triggered proactive agent turns are a proven pattern, and background/aux
LLM calls should reuse one client + cheap-model tier (our `llm.ts` +
`workLlm` already match).

### Pattern extraction

| Pattern | Gas Town | Orca | Podium today |
|---|---|---|---|
| Concierge the human talks to | Mayor | (coordinator session) | superagent chat (manual) |
| Event/heartbeat-driven steward | Deacon + patrols | — (skill, ad hoc) | **missing** |
| Unsticking idle/stalled workers | Witness + nudge | completion signals | **missing** (auto-continue covers errors only) |
| Work DAG auto-promoting ready | beads | DAG in skill | ✅ derived ready/blocked |
| Handoff/completion protocol | hook + handoff | handoff model | convention only (§10.3 completion note) |
| Human decision gates | Overseer mail | decision gates | needs_human flag (not routed) |
| Merge serialization | Refinery | — | per-issue merge action (manual trigger) |

## 3. What Podium already has (inventory)

Actuators are largely done; what's missing is the nervous system.

- **Issue DAG**: full CRUD + `claim` (atomic work-stealing) + `ready`/
  `blocked` derived (closing a blocker auto-unblocks dependents on next
  read), `needs-human`, `defer`, `doctor`/`lint`/`stale`/`orphans`, epics,
  `discovered-from`. One command registry drives CLI + MCP.
- **Session state**: hooks → classifier → reducer → persisted `AgentPhase`
  (`working | idle | needs_user | errored | compacting | ended`) with idle
  verdicts (`done|question|approval|open_todos|interrupted`) — exactly the
  signal an orchestrator needs, already reconciled and persisted.
- **Driving sessions**: `createSession` (initialPrompt via argv),
  `resumeSession`, `resumeAndSend`, `sendTextWhenReady`, `continueSession`,
  `answerAskUserQuestion`, `harnessExec` (headless `claude -p`/`codex exec`
  one-shot with MCP + allowed-tools). Issue `start()` auto-claims and spawns;
  `action('merge')` ff-merges and auto-closes.
- **Superagent**: chat-triggered orchestrator with the right tool belt
  (`list_sessions`, `start_agent`, `send_to_agent`, `read_session_transcript`,
  `git`, `create_worktree`, issue tools via in-process MCP), persistent
  SQLite threads, api + harness backends.
- **Authz**: capability model (`viewer|worker|admin` × scope) with cwd-minted
  worker/subtree caps for agents and OPERATOR for humans/in-process callers.
- **Notify**: `attentionEvent` broadcast + ntfy/Telegram push when no client
  is watching.

Gaps (verified against source): no event log or subscriptions (only
transient WS broadcasts); no scheduler/cron/wakeup of any kind; the pump
(auto-dispatch) explicitly unbuilt; superagent never runs unprompted; no
headless orchestrator principal; needs_human is a flag, not a routed
request with context; completion notes are convention, unenforced; `--json`
CLI output is half-implemented and `show`/`comment`/`dep-add` fail to
resolve display ids (#11) — fatal for agent-driven operation.

## 4. Vision

Two hats, one brain. Both are prompts over the same superagent service —
no new agent framework.

### The Concierge (the + button; Gas Town's Mayor)

The user's single entry point. Typing a wish into the + button starts (or
continues) the global concierge thread, primed with cross-project context:
repos, boards, live sessions, recent activity. It:

1. **Intake**: matches the wish against existing epics/issues (FTS +
   `find-duplicates`), files an epic/issue tree with sensible deps, or just
   answers if it's a question.
2. **Kickoff**: `issue start` for ready leaves (worktree + branch + agent
   spawn are already wired), with the issue description as the work brief.
3. **Being someone to talk to**: status questions ("where is X?") answered
   from the issue DAG + session states + transcripts, not by making the user
   read terminals. This is Gas Town's biggest UX lesson — honor it.
4. **Re-entry briefs**: when a worker sets needs_human, the concierge turns
   the raw question into a decision card: what the agent is doing, what it
   needs, the options and consequences, links to the artifact/diff. The
   user's context-switch cost is the product problem being solved.

### The Steward (Gas Town's Deacon+Witness, scoped down)

A headless, event-woken housekeeping loop. Not resident — each trigger runs
one bounded turn (superagent api-backend or `harnessExec` one-shot) with a
trigger-specific prompt and a small tool belt. Duties, by trigger:

- **Issue closed** → compute newly-ready dependents; for sessions that were
  waiting on the blocker, `resumeAndSend` a "your blocker #N closed, here's
  its completion note" nudge; for unclaimed ready issues, dispatch under the
  pump policy (§5.3).
- **Session went idle** → reconcile: does the bound issue reflect reality?
  (stage, completion note present, discovered work filed, title sane,
  branch pushed/PR'd per gitWorkflow). If the agent finished but didn't
  close, nudge it once to finish its bureaucracy (GUPP-style); only fix up
  the tracker directly if the session is gone.
- **Session needs_user / issue needs_human** → build the re-entry brief
  (concierge hat), route a notification, snooze-aware.
- **User replied while agents waited** → deliver the answer to the waiting
  session (`answerAskUserQuestion`/`resumeAndSend`) and clear needs_human.
- **Timer (sparse, e.g. hourly)** → `doctor`, `stale`, `orphans`, `lint`;
  defer-until and snooze returns; escalate anything wedged (a session
  `working` for hours with no output → Witness-style check-in).

Every steward action is auditable: it acts as principal `agent:steward`,
writes an issue comment for anything it changed, and never force-pushes,
deletes, or merges without an explicit gate (§5.4).

### Working-agent duties (not the steward's job)

Gas Town pushes bureaucracy into role prompts; we already have the
injection point (`prime` hook context + AGENTS.md). Titles, completion
notes, discovered-from links, stage updates are **the working agent's
duty**, stated in prime; the steward is the backstop that notices and
nudges, not the maid that silently fixes. This keeps blame legible and
avoids two writers fighting over the same fields.

### The sidebar: where agents live (2026-07-02 revision)

Audit finding: an agent-created session (`start_agent`) today is a
metadata-poor twin of a human session — title = `basename(cwd)`, no
workState, no creator record, issue membership only if the cwd happens to
land inside an issue worktree. Nothing anywhere records *who spawned it*.

Target sidebar structure:

1. **NEEDS YOUR ATTENTION** — stays. Signal quality improves via the
   completion-note contract and structured needs_human questions; agents
   are instructed (prime) to send concrete signals rather than us inferring.
2. **WORKING** — stays, but batched: sessions grouped under their issue row
   (one row, "3 working" badge), issue-less sessions under their worktree
   row. Note: harness-internal subagents (Claude's Task tool) never create
   Podium sessions, so the flood risk is only Podium-spawned sessions —
   issue/worktree grouping covers it.
3. **PINNED PANELS** — keep as-is until the "spaces" idea is fleshed out.
4. + 5. **Worktrees and issues merge into one list.** An item is an issue
   (grouping its sessions) when the worktree belongs to one or more issues
   — show only the issue(s); a bare worktree row otherwise. This makes the
   issues system incrementally adoptable. Feasible today: membership is
   already cwd-containment (`sessionsForIssueWorktree`, `isMemberCwd`);
   IssueBlock UI exists. Multi-issue worktrees show each issue.

## 5. Missing primitives (the distillation)

In dependency order. 1–3 are the real build; the rest are mostly policy
and prompts over existing machinery.

### 5.1 Event substrate (P1)

A durable, subscribable event log; today's WS broadcasts are transient and
untargeted. In-process emitters at the two choke points that already see
every transition: `IssueService.persist()` (diff old→new: closed,
ready-set-changed, needs_human set/cleared, stage changed) and
`relay.ts:notifyAttention` (phase transitions: →idle with verdict, →
needs_user, →errored, →ended). Append to a SQLite `events` table
(id, ts, kind, subject, payload, consumed_by) so triggers survive restarts
and the steward can catch up after downtime. This is also the substrate a
future UI activity feed reads.

### 5.2 Trigger queue + scheduler (P1)

Concretely, one server module (`steward/triggers.ts`) with four parts:

- **Trigger rules**: pure functions mapping events → a trigger key +
  handler, e.g. `issue.closed → unblock:<repoPath>`,
  `session.idle → reconcile:<sessionId>`, `issue.needsHuman →
  brief:<issueId>`. Rules are data, easy to list and test.
- **Coalescing**: a trigger fires N seconds (≈30s) after the *last*
  contributing event, carrying every event since the previous run. Closing
  an epic's final child (epic auto-close + five dependents newly ready = 7
  events) → **one** run with all seven in the payload, not seven runs.
- **Serialization + backoff**: one run at a time per repo; events arriving
  mid-run queue a follow-up. Exponential backoff on runs that produce no
  actions (Gas Town patrols). Crashed runs leave events unconsumed for a
  capped retry.
- **Timer rows**: `fireAt` rows scanned by one interval — defer-until
  wakeups, snooze returns, "working >2h with no output?" checks, a sparse
  hourly tidy tick.

**Handlers come in three tiers, cheapest first** (this answers
"deterministic or agent?"): (a) **deterministic** — no LLM at all: "blocker
closed → look up waiting/dependent issues, `resumeAndSend` the completion
note to their sessions, or dispatch under the pump policy" is a lookup plus
a template; (b) **background LLM call** via the existing `llm.ts` path
(cheap `workLlm`) where judgment is needed — reconciling a messy idle
session, composing a re-entry brief; (c) **headless harness one-shot**
(`harnessExec`) only when repo files must be touched. Most traffic is tier
(a). Every run writes to an auditable runs feed (the event log again).

Worked example: agent closes #12 → events `issue.closed(#12)`,
`issue.ready(#13)`, `issue.ready(#14)` → one `unblock` run 30s later →
deterministic handler: #13 has a parked session waiting on #12 →
`resumeAndSend("#12 closed — completion note: …")`; #14 is unclaimed and
its epic is mode=Auto with capacity → `issues.start(#14)`; both actions
logged as events + issue comments. No LLM was involved.

Absorbs `AutoContinueController` eventually (error-retry becomes one more
trigger rule).

### 5.3 The pump: auto-dispatch under autonomy modes (P2)

The deliberately-deferred piece of the issues-in-agents design. **The pump
itself is deterministic — no LLM**: a priority-ordered walk of `readyList`
filtered by mode, caps, and budget, dispatching via the existing
`issues.start()`. The LLM only appears in steward judgment handlers (§5.2
tier b).

**Autonomy is a user-visible field on the epic** (inherited by children,
per-issue override, repo-level default), three modes:

| | dispatch of ready work | agent questions | merge |
|---|---|---|---|
| **Interactive** (default) | human (or human-via-concierge) starts it | needs_human → re-entry brief → user | human |
| **Auto** | pump auto-starts within caps + budget | needs_human → brief → user | decision gate (user confirms) |
| **Full Autonomy** | pump auto-starts | agents primed "don't ask — decide, record it in the completion note"; steward answers what it can from epic context; only hard failures escalate | auto-merge when checks green; conflicts escalate |

Triggered **manually** (user creates epic/issue in the UI): mode picker on
the create form, defaulting to Interactive. A bare issue carries the same
field. Triggered **via concierge**: the concierge proposes a mode + budget
inferred from the wish's phrasing ("ship this overnight" → Full with a
budget; "let's work through X" → Interactive), states its choice explicitly
in the reply, and sets the same field via issue tools — one field, no
separate path. Mode changes take effect at the next trigger evaluation.

**Token control is separate from mode** — mode says *who decides*, budget
says *how much*. Hard controls: per-epic token/run budget, concurrency caps
(start: 2 auto-dispatched/repo, 4/machine, respecting the rate-limit
signals already in HostIndicators), and a global pause switch. Full
Autonomy ≠ unlimited spend; it means "don't wait for me," bounded by the
budget. Every auto-dispatch is an event row + issue comment.

### 5.4 Steward principal + gates (P1)

To be unambiguous: **the steward is not an agent, not a session, and not a
thing anyone starts or talks to.** It is a server-side service inside
podium-server (like `AutoContinueController` or the issue assistant): the
trigger queue plus its handler registry. It has no PTY, no thread, no
sidebar row. Nobody owns it per-user; there is one per server, serialized
per repo. Its runs surface only as event-log rows and issue comments.

"Principal" means only the **identity and permission set its mutations run
under**: author/assignee string `agent:steward` + a capability of role
`worker` with scope `all` (deliberately not admin — it cannot delete or
archive). Today the alternatives are OPERATOR (the human's full authority —
wrong for audit and blast radius) or cwd-scoped worker (too narrow to
coordinate across issues). It's an authz row, not a being.

Destructive or outward actions (merge, push, delete, killing a session) are
**decision gates**: the steward files/updates a needs_human with a prepared
decision card instead of acting. Orca's gates + our existing
confirm-required pattern. (In Full Autonomy mode, merge-on-green is
delegated per §5.3; the other gates remain.)

### 5.5 Handoff protocol: structured completion notes (P1, small)

Promote the §10.3 convention to a checked contract: `issue close` grows
`--note` (stored as a marker comment); prime tells agents a close without a
note is a lint violation; steward treats "session idle+done but issue open
or note missing" as its main nudge trigger. Completion notes are what the
steward forwards to unblocked dependents — they're the inter-agent message
bus, no new messaging system needed (Orca's "clear handoff model" lesson).

### 5.6 Re-entry briefs + artifact elicitation (P3)

- **Brief**: on needs_human, a steward run composes a decision card
  (question, current state, options/consequences, links) stored as an issue
  comment with a marker so the UI can render it specially — the + button
  thread and the notification both point at it.
- **Artifact elicitation**: at milestones (planning→in_progress,
  review), the steward asks the working agent (one nudge) to emit/refresh a
  short explainer artifact — `docs/…` in the worktree or an issue comment —
  optimized for a human re-entering cold. Start with comments + existing
  markdown preview; a dedicated artifact tier only if this proves out.

### 5.7 Agent-grade CLI plumbing (P1, prerequisite — filed as #48)

Root-caused 2026-07-02 (supersedes #11): there is **no seq→id resolver
anywhere** — the store keys by `iss_<uuid>`, the CLI prints `#<seq>`
(per-repo counter), and every id-taking command feeds the raw string into a
uuid-keyed map (`issues.ts:339/446/807`); `prime` only works because the
capability path mints the internal uuid from cwd. `--json` is a hardcoded
`{command, ok}` envelope with human text appended (`issue-cli.ts:87`).
**`start` is missing from the command registry entirely** even though
prime's output instructs agents to run it — agents cannot start issue-bound
work. Plus: positional args silently ignored, nameless "Required" Zod
errors, inconsistent exit codes, `--outside-scope` only via argv sniffing,
e2e test masks the bug by fetching the internal uuid via the typed client.
Full fix list + acceptance criteria in issue **#48** (P1). Also wanted
here: `podium issue events --since <cursor>` for §5.1 debuggability.

Without these, the orchestrator can see work it cannot act on.

### 5.8 Session provenance + first-class spawn metadata (P1)

Audit verdict: agent-created sessions are metadata-poor and anonymous. No
session field records its creator (`SessionOrigin` is only
`spawn|resume`); `start_agent` passes only `{agentKind, cwd}` — title
defaults to `basename(cwd)`, workState unset, issue membership only by
accidental cwd containment; and the tool belt cannot answer a session's
question, resume/continue a parked session, snooze, rename, set workState,
or gracefully hibernate. There is no parent/child or hidden-session
concept (the conversation-index `parentId` covers only harness-internal
Task subagents, which never become Podium sessions).

Fixes, so an agent-spawned agent is fully at home:

- **`spawnedBy` on SessionMeta + sessions table**:
  `user | concierge:<threadId> | steward | session:<sessionId> |
  issue:<issueId>`. Enables audit, UI grouping/dimming of helper sessions,
  and steward policies ("nudge only sessions I dispatched").
- **`start_agent` grows up**: accepts `title` (required-ish; fall back to
  first-line-of-task), `issueId` (routes through the `issues.start()` path
  so worktree/branch/binding are guaranteed), seeds `spawnedBy`.
- **Expose `issue_start`** as CLI verb + MCP tool (the server proc exists;
  the verb doesn't — part of #48). This is the sanctioned way for an agent
  to spawn issue-bound work; bare `start_agent` remains for unbound helpers.
- **Tool-belt completion** (each is an existing tRPC/registry capability
  with no tool today): `answer_question` (answerAskUserQuestion),
  `resume_and_send`, `continue_session`, `snooze`, `rename_session`,
  `set_work_state`, `hibernate` (graceful, vs the existing kill), and a
  `wait_for_session` completion signal (subscribes to the §5.1 event log —
  Orca's "wait for completion signals").
- **Visibility policy**: no hidden sessions for now — transparency wins;
  the sidebar merge (§4) handles clutter by grouping under issues/worktrees,
  and `spawnedBy` gives us dimming/filtering later if needed.

## 6. What we deliberately do NOT build

Per the standing principle — don't duplicate what the harness vendors ship
natively and iterate on fast:

- **No in-session orchestration**: no molecules/formulas/protomolecules, no
  subtask fan-out engine. Claude Code has subagents, Workflow, skills,
  hooks; Codex is following. Decomposition *within* a task belongs to the
  working agent; Podium orchestrates *across* sessions/worktrees via the
  issue DAG only.
- **No own agent loop**: steward/concierge brains are the existing
  superagent backends (`api` or `harnessExec`). If harnesses ship stable
  ACP, we adopt it rather than deepen scraping.
- **No seance clone**: harness-native `/resume` + our transcript reads
  cover predecessor interrogation.
- **No 20-30-agent scale machinery**: no patrol hierarchies, wisps, or
  watchdog-dogs. One steward loop, systemd is its watchdog. Revisit at
  scale.
- **No new messaging system**: issue comments/completion notes are the
  inter-agent mail; sessions are reached via existing send/resume.

## 7. Phasing

- **P0 — prerequisite**: agent-grade CLI plumbing (#48). Fix first.
- **P1 — nervous system**: event log + trigger queue + steward principal +
  completion-note contract + session provenance/spawn metadata + tool-belt
  completion (§5.8). Steward duties: unblock notifications, idle
  reconciliation nudges, tracker tidy tick. No auto-dispatch yet — every
  dispatch still human- or concierge-initiated.
- **P2 — the pump**: opt-in autonomy flag, caps, auto-dispatch of ready
  work, wedge detection/check-ins.
- **P3 — concierge UX**: + button entry point wired to the global
  superagent thread with intake protocol; re-entry briefs on needs_human;
  artifact elicitation at milestones.
- **P4 — polish/scale**: convoy-style delivery tracking view over epics,
  merge-queue serialization if parallel merges start colliding, per-issue
  model/effort selection.

Each phase is independently shippable and useful; P1 alone removes the
"human as message bus" tax.

## 8. Decisions (resolved 2026-07-02) + remaining questions

1. **Steward brain — flexible by construction.** Handlers declare what they
   need; three tiers (§5.2): deterministic (most traffic, no LLM) →
   background LLM via the existing `llm.ts` backend abstraction (which
   already spans subscription OAuth / API credits / API keys —
   anthropic/openai/openrouter/codex-oauth) → `harnessExec` one-shot only
   when repo files must be touched. No resident agent is needed; the brain
   choice stays a per-handler seam, decided later per deployment.
2. **Concierge lives per project (≈ per repo for now)**, thread id like
   `concierge:<repoPath>`. The + button routes by the view the user is in;
   the user never chooses. Context bloat is handled with the btw-thread
   recap/watermark machinery. **No concierge-to-concierge messaging** —
   cross-repo coordination goes through the tracker if it ever matters
   (YAGNI now). The concierge is reserved for the user: working agents
   never talk to it; they write completion notes / needs_human, and steward
   handlers route those into the concierge thread as briefs. One-way flow,
   no agent-to-agent chat protocol.
3. **Nudge, narrowed.** A nudge is (a) *delivery of new facts to a stopped
   session* — your blocker closed (with its completion note), the user
   answered your question — which no system prompt can do, because prompts
   can't act after the agent stops or carry information that didn't exist
   yet; and (b) *one* post-condition reminder when a session idles with
   unfinished bureaucracy (issue open, note missing, branch unpushed).
   Category (b) is a backstop for prime-prompt failures: we track its
   causes and tighten prime until it's rare. After one reminder →
   needs_human. It is not a "keep working" whip.

Remaining open:

1. Budget accounting for the pump — what unit can we actually meter
   (sessions dispatched? harness-reported token usage? wall-clock)?
   Rate-limit gauges exist per agent (HostIndicators) but per-epic token
   attribution does not.
2. Multi-issue worktrees in the merged sidebar: session shown under every
   matching issue vs the most specific one — pick during UI implementation.
3. Full-Autonomy merge-on-green needs a definition of "checks green" per
   repo (CI? typecheck+tests via a verify step?) before it can be enabled.
