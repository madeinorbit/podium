# Agent self-report: declared stop reasons + agent-initiated contact

Status: Phase 1 (stop report) **BUILT** on `worktree-agent-self-report-design`
(issue #146). Phase 1b (stop-hook enforcement) and Phase 2 (agent-initiated
contact) remain design — filed as follow-ups. Builds on the empirical work in
`docs/agentstate/claude.md` (deterministic classifier labels) and
`docs/agentstate/claude-semantic-v2.html` (LLM benchmark on the
finished-vs-question ambiguity over ~50 gold-labeled real stops).

## What shipped in Phase 1

The three-axis vocabulary below (`StopOutcome` / `StopNeed` / `StopAttention`)
and the `AgentStopReport` type live in `packages/protocol/src/messages.ts`; the
report rides `SessionMeta.stopReport`. An agent files one with:

```
podium report --outcome <o> --need <n> --attention <a> --summary "…" [--options "a,b,c"]
```

Path: the CLI (`apps/cli/src/session-cli.ts`) POSTs `{router:'session',
proc:'report'}` to the daemon's issue-relay loopback (like `podium worktree`);
the daemon (`apps/daemon/src/daemon.ts`) validates against `AgentStopReport` and
forwards a `sessionReport` frame; the server (`apps/server/src/modules/sessions/
service.ts`) stamps its own clock onto `at`, stores it on the session (persisted
as a `stop_report` JSON column, migration 009), broadcasts, and **clears it the
moment the agent starts a new turn** (working/compacting). The sidebar reads it:
`attentionGroup` / `attentionSummary` (`packages/client-core/src/focus.ts`) let
a report override the inferred phase, and `sessionUrgencyRank`
(`packages/client-core/src/viewmodels/derive.ts`) orders `blocking > soon >
working > whenever`. Un-reported sessions keep byte-for-byte their old ordering
— the report only ever refines. The deterministic classifier stays the floor.
Tests: `session-cli.test.ts`, `focus.test.ts` (stop report override),
`derive-report-rank.test.ts`, `store.test.ts` (JSON round-trip),
`session.test.ts` (#146), `relay.test.ts` (stamp/broadcast/clear),
`daemon.test.ts` (relay validate + forward).

## 1. Why

Today the stack infers why an agent stopped:

- **Tier 1 (deterministic)**: hooks + transcript features →
  `idle.finished / idle.interrupted / idle.needs_input.{ask_user_tool,
  permission, approval, open_todo_list, text_question} / error / working.*`
  (`packages/agent-bridge/src/agent-state/`).
- **Tier 2 (semantic, benchmarked but not shipped)**: an LLM deciding the one
  genuinely hard case — is the trailing "Want me to also update docs?" a
  courtesy offer (`idle.finished`) or a blocker
  (`idle.needs_input.text_question`)?

The semantic-v2 study showed this is exactly the case where *only the agent
knows the answer*. So add **Tier 0: self-report** — the agent declares, in
structured form, what state its work is in, what it needs, and how urgently.
Inference stays as the floor (uninstrumented agents, crashes, agents that
forget), self-report is authoritative when present and fresh.

The report is also the input the sidebar has been missing: today
`sessionUrgencyRank` (derive.ts) lumps every non-working recent session into
rank 0. With reports, "blocked on a production credential" and "finished, FYI"
can order differently.

## 2. The stop report

Three orthogonal axes. Keeping them orthogonal matters: "outcome" answers
*what happened to the work*, "need" answers *what unblocks or advances it*,
"attention" answers *how the user should triage it*. Collapsing them into one
enum (the mistake to avoid) forces agents into wrong buckets and gives the
sidebar nothing to sort on.

```ts
export const StopOutcome = z.enum([
  'done',            // deliverable complete and verified
  'done_unverified', // complete but something was skipped (tests not run, not exercised e2e)
  'partial',         // some done; remainder blocked, descoped, or awaiting input
  'blocked',         // could not make (further) progress
  'failed',          // attempted, didn't work; explained in summary
])

export const StopNeed = z.enum([
  'none',       // nothing needed from the user
  'review',     // look at output before the next step (plan, PR, findings)
  'answer',     // a question only the user can answer (info, context)
  'decision',   // a choice between options (scope, approach, destructive action)
  'access',     // credentials / auth / permission / environment the agent lacks
  'external',   // waiting on something outside the user (CI, deploy, another issue)
])

export const StopAttention = z.enum([
  'blocking',  // work is stopped until the user acts
  'soon',      // work/turn ended fine, but the need gates completion or merge
  'whenever',  // FYI; nothing gated on the user
])

export const AgentStopReport = z.object({
  outcome: StopOutcome,
  need: StopNeed,
  attention: StopAttention,
  /** One line, user-facing: why I stopped + what I need. Sidebar row subtitle. */
  summary: z.string().max(200),
  /** Optional: for `decision`, the concrete options, so the client can render
   *  one-tap replies (same shape AskUserQuestion uses). */
  options: z.array(z.string()).optional(),
  turnId: z.string(),   // the stop this report belongs to — see validity
  at: z.string(),       // ISO 8601
})
```

**Extensibility.** The three axes WILL churn — expect to add/rename values every
so often. They're `z.enum`s, so adding a value is a one-line change per axis, and
the design degrades safely at both ends: a persisted report whose value a client
doesn't recognise fails `AgentStopReport.safeParse` on load and reads as *no
report* (`Session.parseStopReport`), never a blanked session list; and because a
report is transient (cleared on the next turn), a rename can't leave stale-but-
wrong reports around for long. So: adding a value is backward-compatible; renaming
/removing one just drops in-flight reports that used it (acceptable). The one rule
to preserve is that every `StopAttention` value has a defined sidebar rank in
`sessionUrgencyRank` and a group in `attentionGroup` — a new attention value with
no rank silently falls through to the un-reported default (rank 0), which is a
safe-but-lossy default, so wire the rank in the same change.

Notes on the vocabulary (grounded in the observed labels):

- The deterministic labels' `ask_user_tool / permission / approval` need no
  self-report — they are detected exactly (unresolved AskUserQuestion,
  permission prompt, plan mode) and stay deterministic. Self-report exists for
  the fuzzy remainder: `text_question` vs `finished` vs `open_todo_list`.
- `open_todo_list` maps to `outcome: partial` + whatever need actually blocks
  it — the report is strictly more informative than "todos remain".
- `interrupted` stays deterministic (it's a user action, not an agent state).
- `error` stays deterministic for harness errors (rate limit, 5xx — with
  `retryable`); `outcome: failed` is for *task-level* failure the agent can
  narrate.

### Validity and reconciliation

- A report binds to one stop (`turnId`). Any new user prompt, new turn, or
  interrupt invalidates it. No decay heuristics needed — staleness is
  structural.
- Deterministic hard facts outrank the report: an unresolved AskUserQuestion
  or permission prompt shows as needs-input even if the agent filed
  `need: none` (it can't have — but crashes mid-report happen).
- No report on an instrumented agent's stop → fall through to today's
  deterministic tiers, exactly as now. Self-report is additive.

### How agents file it

`podium session report --outcome done --need review --attention soon
--summary "…"` (CLI; MCP tool mirrors it). Enforcement uses the mechanism we
already shipped for mail (`0f8898d` — stop-hook blocks the idle transition):

- Stop hook checks: does a report exist for this turn?
- If yes → stop proceeds.
- If no AND the deterministic classifier lands in
  `needs_semantic_classification` → **block the stop once** with "file a stop
  report (`podium session report …`) before ending your turn."
- If no and the deterministic result is unambiguous → let it stop (don't tax
  every trivial turn with an extra round trip).

This replaces the planned Tier-2 LLM classifier with the agent itself — which
has full context, and costs one cheap turn only in the ambiguous cases the
LLM would have been called for anyway.

### Sidebar ordering

Extend `sessionUrgencyRank` (keep the existing primitives; refine rank 0):

| rank | today | with reports |
|---|---|---|
| 0 | any recent non-working | `attention: blocking` (and deterministic needs-input) |
| 0.5 | — | `attention: soon` — review/decision gating completion |
| 1 | working | working (unchanged) |
| 1.5 | — | `attention: whenever` / `outcome: done` FYI — visible, below working is wrong though: keep just above snoozed, below `soon` |
| 2 | snoozed | snoozed |
| 3 | stale/exited | stale/exited |

(Exact rank numbers TBD in implementation; the point is *blocking > soon >
working > fyi-finished > snoozed > stale*, with `summary` as the row subtitle
and time-blocked as the within-rank tiebreak for blocking rows.)

## 3. Agent-initiated contact

The stop report is passive turn-end metadata. Contact is the active channel:
the agent messages the user **without stopping** (or from mid-turn, or about
something unrelated to its own task). Today the only channels are: stop and
hope the heuristics notice (loses the work-in-flight), AskUserQuestion
(blocks the turn), or issue comments (no routing/urgency).

```
podium contact --urgency now|next|fyi --body "…" [--options "a,b,c"] [--issue <id>]
```

| urgency | delivery | use when |
|---|---|---|
| `now` | push notification (mobile/web) immediately; session/issue jumps to top with a distinct badge | user would want to be interrupted |
| `next` | inbox + attention bucket; no push (unless user opts in) | needed before the work completes, not this minute |
| `fyi` | inbox only; digestable | progress, findings, nothing gated |

### Storage: not a new silo

A contact is stored as an **issue event/comment with routing metadata**
(`audience: user`, `urgency`), on the session's attached issue (or the
session itself when unattached). This makes it symmetric with what exists:

- `podium issue mail send <id>` = agent → *agent* routing (delivered at the
  target's stop hook).
- `podium contact` = agent → *user* routing (delivered per urgency table).
- Issue comments = the durable record both are views over.
- `AttentionEventMessage` stays the deterministic floor
  (question/permission/error/plan) and becomes one more producer into the
  same delivery pipe — deterministic events are implicitly `now`.

The inbox (mobile `InboxScreen`, web equivalent) is then a *view*: unread
contacts + deterministic attention events, ordered by urgency then time.
**Replying to a contact routes back through the existing outbox**: live
session → inject as a message; hibernated → queued message
(`queuedMessageCount` machinery). A `now`/`next` contact with `--options`
renders one-tap replies on mobile.

### Use cases

1. **Non-blocking decision mid-work** (the big win): "The migration also
   touches billing. I'm continuing with the other 14 tables; I need a
   decision on billing before I can merge." → `next` + options. Today this
   forces a full stop or a blocking AskUserQuestion.
2. **Destructive-action heads-up**: "Ready to drop the old columns on
   staging — say stop if you object, proceeding when you approve." → `now`.
3. **Out-of-scope urgent discovery**: found a leaked credential / failing
   prod deploy / security hole while doing unrelated work → `now`, even
   though its own task continues; also files a `discovered-from` issue.
4. **Long-job progress**: "Backfill 60% done, ETA 40 min, no anomalies." →
   `fyi`. Keeps the user from opening the session to check.
5. **Budget/limit warnings**: "This sweep will take ~2M tokens / we're near
   the rate-limit window — confirm or I'll pause at the threshold." → `next`.
6. **Cross-agent deadlock escalation**: two issues' agents both need to
   rework `messages.ts`; their mail exchange can't resolve priority →
   either escalates with `next`.
7. **Scheduled/overnight runs**: routine finished its report → `fyi`;
   routine failed or found something requiring action → `next`/`now`.
8. **Deferred question**: "Answer whenever — which naming do you prefer for
   the public API? I'll incorporate it when it arrives and use X meanwhile."
   → `fyi`/`next`; the reply lands as a queued message / task-notification.

### Abuse/inflation guards

Urgency inflation is the failure mode (everything becomes `now`).

- Prompt guidance with concrete calibration examples (this doc's table).
- Rate-cap `now` per session (e.g. 2/hour) — excess degrades to `next` with
  a note.
- One-tap user feedback on any contact ("this wasn't urgent") recorded on
  the issue → feeds the agent's next-turn context and, aggregated, the
  prompt guidance.

## 4. Build order (suggested)

1. Protocol: `AgentStopReport` on `AgentRuntimeState` (alongside `idle`),
   `podium session report` CLI + stop-hook enforcement for the ambiguous
   case.
2. Sidebar: rank refinement + summary-as-subtitle.
3. `podium contact` + issue-event storage + inbox view (mobile first — the
   InboxScreen exists).
4. Delivery: push for `now` (PushNotification / web notification path via
   `AttentionEventMessage` generalization), reply-routing through outbox.
