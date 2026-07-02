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

Maps events → steward runs. Coalescing/debounce per subject (an issue close
that unblocks five dependents = one run, not five), a serialization lock
(one steward run at a time per repo), and a timer wheel for the sparse
patrol tick, defer-until wakeups, and "still working after N hours?"
checks. Escalating backoff when runs produce no actions (Gas Town patrols).
A crashed run marks its event unconsumed for retry with a cap. This is
~one file next to `AutoContinueController`, which it should eventually
absorb (error-retry becomes just another trigger).

### 5.3 The pump: auto-dispatch policy (P2)

The deliberately-deferred piece of the issues-in-agents design. Server-side
dispatch of ready issues under explicit consent and caps:

- **Autonomy is opt-in per epic/issue** (`autonomy: manual | dispatch`,
  inherited down the tree). Default manual — the concierge asks "want me to
  keep this epic moving?" and sets it.
- **Caps**: max concurrent auto-dispatched sessions per repo and per
  machine (start: 2/repo, 4/machine), respecting agent rate-limit signals
  we already surface in HostIndicators.
- **Mechanism exists**: dispatch = `issues.start()`. The pump only decides
  *whether/when*.

### 5.4 Steward principal + gates (P1)

A headless capability: `agent:steward`, role `worker`+scope `all` (not
admin — it must not delete/archive), minted in-process for steward runs and
audited under its own assignee/author name. Destructive or outward actions
(merge, push, delete, killing a session) are **decision gates**: the steward
files/updates a needs_human with a prepared decision card instead of acting.
Orca's gates + our existing confirm-required pattern.

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

### 5.7 Agent-grade CLI plumbing (P1, prerequisite)

- Fix display-id resolution in `show`/`comment`/`dep-add`/… (#11).
- Finish `--json` output (currently prints `{"ok":true}` plus text).
- `podium issue events --since <cursor>` for debuggability of §5.1.

Without these, the orchestrator can see work it cannot act on.

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

- **P1 — nervous system**: event log + trigger queue + steward principal +
  completion-note contract + CLI plumbing fixes. Steward duties: unblock
  notifications, idle reconciliation nudges, tracker tidy tick. No
  auto-dispatch yet — every dispatch still human- or concierge-initiated.
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

## 8. Open questions (needs-human)

1. **Steward brain default**: superagent `api` backend (cheap `workLlm`,
   fast, no sandbox) vs `harnessExec` claude-code one-shot (subscription
   auth, tools, slower)? Proposal: api-backend for reconciliation/briefs,
   harnessExec only when the steward must touch a repo.
2. **Where does the + button thread live** — reuse the existing global
   superagent thread or one concierge thread per repo? Proposal: global,
   with per-repo context loaded on demand (matches "one server, many
   repos").
3. **Nudge etiquette**: how many times may the steward nudge an idle agent
   before escalating to needs_human? Proposal: once, then escalate.
