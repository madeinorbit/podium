# Field-schema inventory — every session and issue representation, and the composition plan

**Issue:** POD-364 (1.4a) · Phase 1 (POD-288), child of POD-302 · **Counted at** `0e583f44`
(`issue/279-integration`, 2026-07-29 23:59 +0200) · **Written** 2026-07-30

**Governing documents.** ADR 4 (representation policy) + Amendment 1 (D8–D10),
ADR 9 (identity, ownership, sharing — D3 visibility classes, D4 default-closed, D5 attribution),
ADR 1 Amendment 1 (D8 matrix columns, D10 per-user state, D12 `op-stream`),
`docs/multi-user-readiness.md` (the human decisions of 2026-07-29 — **it wins over the brief**).

**What this document is.** A characterization. No production code changed. It answers three
questions and hands three lists forward:

1. **How many representations of "a session" and "an issue" exist today, and which are
   legitimate** (R1–R6 per ADR 4 D2) versus **drifted duplicates**. §2, §3.
2. **What each field authoritatively means**, who writes it, which representations carry it,
   and where the definitions **disagree**. §4, §5 — the disagreements are the deliverable.
3. **The composition plan POD-365 executes**: which shared field schemas exist and what each
   representation `Pick`s. §6. Ownership (`owner` / `visibility` / `grants`) is placed
   **once**, in §6.1.

Handed forward: per-user-state candidates + two open questions → **POD-1076** (§7);
the reserved `op-stream` set → **POD-1071/POD-304** (§8); attribution gaps → **POD-304 /
POD-1075** (§9); the **existence-leak list** → **Phase 3, POD-290** (§10).

---

## 1. Method, and why the counts can be trusted

The epic's stated premise is "roughly eight parallel definitions of a session". That number is
**wrong by roughly 3×**, and a grep sweep would not have proved it either way. What was done
instead:

**1. The file list comes from `git ls-files`, not from a search.** 1576 tracked `.ts`/`.tsx`
files (0 `.kt`/`.swift` — the mobile app is React Native TypeScript, so there is no separate
native session shape). Every file is **read whole** and NUL bytes are stripped **before**
parsing.

> **This is not hypothetical. The NUL hazard was live on this document's own base.**
> `bun scripts/check-no-nul-bytes.ts` **exits 1 at `0e583f44`** (verified in a detached
> worktree): `BINARY: packages/client-core/src/engine/engine.ts` — **two** literal `0x00` bytes.
> A `grep`/`rg` sweep of that 1732-line file returns **no matches and exit 0**: it is invisible.
> It holds `EngineState`, the client's whole session/issue view state. Read directly, it turns
> out to **compose** `SessionMeta[]` / `IssueWire[]` rather than restate them (§2, last rows), so
> the inventory does not change — but that conclusion was only reachable by reading bytes.
> **Independently corroborated while this document was being written:** `3d31eee7`
> ("engine.ts was invisible to grep — two literal NUL bytes", POD-758) landed the fix on
> `issue/279-integration`, and the guardrail is green at the current tip `201dd989`. Two
> sessions found the same invisible file the same week. See §11.

**2. The predicate is mechanical.** Following ADR 4 §1.2: a candidate is a *named* declaration
(`interface X {}`, `type X = {}`, `const X = z.object({})`, `sqliteTable("…", {})`, `class X`)
that declares **≥2 top-level keys** drawn from the session-concept or issue-concept key
vocabulary, matched by a brace-balanced scan (so nested sub-objects do not inflate a shape's
key list). 194 declarations match.

**3. The 194 are then bucketed by hand**, because the predicate cannot tell an entity
representation from a transport frame:

| Bucket | Count | Disposition |
|---|---|---|
| **Session entity representations** | **28** | §2 — 1.4's subject |
| **Issue entity representations** | **17** (+1 compliant `Pick`) | §3 — 1.4's subject |
| L1 transport frames in `packages/protocol/src/messages/*` | 54 | Stay protocol (ADR 4 D4); their **entity-shaped subsets** must compose (§6.4) |
| Drizzle tables (`sqliteTable`) | 21 | 2 are ours (`sessions`, `issues`); the rest are adjacent entities or per-user singletons (§7) |
| Adjacent entities out of 1.4's scope | ~63 | messages, workflows, approvals, conversations, automations, superagent, locks, machines — §12 |
| Test/e2e fixtures | 5 | Noted, not counted (3 × `WireIssue` in `tests/e2e/browser/`) |

**4. Two blind spots, stated rather than hidden.**
- **`Pick`/`Omit`/`Partial` compositions are skipped by construction.** `IssuePatch`
  (`apps/server/src/modules/issues/service/types.ts:302`) is
  `Partial<Pick<IssueRow, …35 keys>>` and does not match the predicate — correctly, because it
  is *already* the compliant pattern ADR 4 D3.2 asks for. The scan therefore **under-reports
  compliant shapes and never under-reports drift**. (ADR 4 §1.2 listed `IssuePatch` as issue
  representation #4; it is better described as the reference example, and §3 records it that way.)
- **Anonymous inline projections are not enumerable as symbols.** `apps/server/src/router.ts`
  alone builds 29 object literals carrying `sessionId:` in a return position. They are real
  drift sites but have no name to address; §6.5 states the rule that removes them
  (a projection with no name is not a representation — it must call a named mapper).

**5. Sizes drifted since the last refresh**, which is why re-counting was required:
`apps/server/src/modules/sessions/service.ts` is **5643** lines (the brief's 2026-07-16 figure
was 3046 — **+85%**); `apps/server/src/modules/sessions/session.ts` 1217; `IssueWire` 78 keys
(ADR 4 counted 71); `SessionMeta` **55** keys (ADR 4 counted 44); `sessions` DDL 48 columns;
`issues` DDL 59. `apps/server/src/modules/sessions/derive.ts` **no longer exists** — deriving
now happens in `packages/client-core/src/viewmodels/derive.ts` and `apps/web/src/lib/derive.ts`.

---

## 2. Session representations — 28, not 8

Role column is ADR 4 D2 (**R1** canonical durable aggregate · **R2** live state · **R3** storage
· **R4** wire/read projection · **R5** narrow port · **R6** portable export). Visibility class is
ADR 9 D3; per ADR 1 Amendment 1 §3 §2 every session row is **`personal`**, and a fact *about a
machine* embedded in a session shape is **inherited** (ADR 9 D3 rule 3), never classified here.

**There is no R1 today.** That is the finding, not an omission: no representation is the
canonical durable aggregate. The nearest thing to truth is spread across `sessions` (48 columns),
`SessionDurableState` (44 live fields, 6 of which have **no column at all**), and
`SessionMeta` (55 wire keys). POD-365 creates the R1.

| # | Symbol / table | Path | Keys | Role | Verdict | Visibility |
|---|---|---|---|---|---|---|
| 1 | `sessions` (drizzle) | `apps/server/src/migrations/schema.ts:21` | 48 | R3 | **legitimate** (physical DDL, ADR 4 D6) | personal |
| 2 | `SessionRow` | `apps/server/src/store/types.ts:101` | 45 | R3 | **legitimate role, hand-restated** — must become the composed mirror of #1 | personal |
| 3 | `Session` (class) | `apps/server/src/modules/sessions/session.ts` | 41 | R2 | **legitimate** (PTY + controller ownership) | personal |
| 4 | `SessionInit` | same file | 42 | R2 | **drifted duplicate** — a third hand-written copy of the row field list plus 2 live wiring fields (`toDaemon`, `onActivity`) | personal |
| 5 | `SessionDurableState` | same file | 44 | R2 | **legitimate role, hand-restated** — the class's own mutable-field contract | personal |
| 6 | `SessionMeta` | `packages/protocol/src/messages/runtime-state.ts:329` | 55 | R4 | **legitimate role, hand-restated**; carries 3 provenance + 2 per-user + 3 derived keys it must shed | personal |
| 7 | `AgentRuntimeState` | same file:50 | 9 | R4 field group | **legitimate** — but `workingMsTotal` has two homes (§5 D-11) | personal |
| 8 | `HandoffManifest` | `packages/protocol/src/messages/handoff.ts:5` | 19 | **R6** | **legitimate** (ADR 4 D4); ids unbranded, `sourceMachineId` is device attribution | personal |
| 9 | `HandoffExportRequestMessage` | same file:44 | 13 | L1 frame | frame stays; its 9-key session subset is **hand-restated** | personal |
| 10 | `SpawnMessage` | `packages/protocol/src/messages/terminal.ts` | 19 | L1 frame | frame stays; the **spawn tuple** subset is hand-restated (and restated again at §3 row 17 and §12) | personal |
| 11 | `HostSessionView` | `apps/server/src/modules/hosts/service.ts` | 9 | R5 | **legitimate** (hibernate scan) — but epoch-ms twins of ISO fields (§5 D-6) | personal |
| 12 | `SessionNoticeInfo` | `apps/server/src/modules/notify/service.ts` | 5 | R5 | **legitimate** (attention/notify) | personal |
| 13 | `RpcSessionView` | `apps/server/src/modules/machines/rpc.ts` | 4 (+1 method) | R5 | **legitimate** — structural port over the *live object* (`transcriptItems()`), not a data shape | personal |
| 14 | `ResumableSession` + `HeadlessFields` | `packages/domain/src/session-identity.ts` | 4 + 1 | R5 | **legitimate** (dedupe predicate; zero-dep domain leaf) | personal |
| 15 | `HandoffSession` | `packages/domain/src/machine-selection.ts` | 3 | R5 | **legitimate** (target pick) | personal (`machineId` **inherited**) |
| 16 | `ConciergeSessionInfo` | `apps/server/src/modules/superagent/concierge.ts` | 7 | R5 | **legitimate** | personal |
| 17 | `BtwSessionInfo` | `apps/server/src/modules/superagent/btw.ts` | 4 | R5 | **drifted duplicate** — a strict subset of #16, re-declared | personal |
| 18 | `FocusSessionInfo` | `apps/server/src/modules/superagent/global.ts` | 1 + extends #16 | R5 | **legitimate — and the one good example in the codebase**: `extends ConciergeSessionInfo` | personal |
| 19 | `AnswerTargetSession` | `apps/server/src/modules/superagent/answer-delivery.ts` | 1 nested | R5 | **legitimate** (reads `agentState.phase`/`need` only) | personal |
| 20 | `CloudAgentSourceSession` | `apps/server/src/cloud-runtime.ts` | 5 | R5 | **drifted duplicate** — renames two facts: `agent` for `agentKind`, `resumeRef: string` for `resume: ResumeRef` (§5 D-1, D-3) | personal |
| 21 | `LakeReadSession` | `apps/server/src/modules/conversations/service.ts` | 3 | R5 | **legitimate**, but narrows `resume` to `{value}` — a third `resume` shape | personal |
| 22 | `IssueTreeSession` | `apps/server/src/modules/issues/service/types.ts` | 8 | R4 | **legitimate role** (issue-tree read projection) — flattens `agentState.phase` to `phase`, renames name/title to `label` | personal |
| 23 | `ShowSession` (CLI) | `packages/issue-client/src/commands.ts` | 10 | R4 (CLI) | **drifted duplicate of #22** — hand-copy plus `agentState:{phase?}`, i.e. *both* the flattened and the nested form in one shape | personal |
| 24 | `SessionStatusResult` | `apps/server/src/modules/sessions/read-toolkit.ts` | 15 | R4 | **legitimate role** (tier-1 status read model) | personal |
| 25 | `StatusWire` (CLI) | `apps/cli/src/session-cli.ts` | 15 | R4 (CLI) | **drifted duplicate of #24** — a key-for-key hand copy, comment admits it ("Tier-1 status wire shape (modules/sessions/read-toolkit)") | personal |
| 26 | `RefSessionLike` | `apps/web/src/lib/ref-miniview.ts` | 6 | R5 | **legitimate** (documented structural subset of `SessionMeta`) | personal |
| 27 | `SessionCardModel` | `packages/client-core/src/viewmodels/session-card.ts` | 8 | viewmodel | **legitimate** — presentation-only; restates just `sessionId`/`title` | personal |
| 28 | `SessionAutoArchiveObservation` | `packages/protocol/src/maintenance.ts` | 5 | R4 | **legitimate** (steward observation payload) | personal |
| — | `EngineState.sessions` | `packages/client-core/src/engine/engine.ts:165` | composes | client state | **legitimate** — `SessionMeta[]`, no restatement. **Grep-invisible (NUL byte)**; verified by reading | personal + per-user UI keys (§7) |
| — | replica collection `sessions` | `packages/protocol/src/messages/sync.ts:53` (`MetadataEntityKind`) | — | R4 carrier | **legitimate** — transports `SessionMeta` verbatim | personal |

**Count.** **28 named session representations** (rows 1–28), of which **6 are drifted
duplicates** (#4, #17, #20, #23, #25 and — as a class — the hand-restated row/wire mirrors #2/#5/#6
that ADR 4 D3.2 forbids once `packages/model` exists). ADR 4 §1.2's "≥9 core" is confirmed and
extended: the three parallel field lists inside `session.ts` alone (#3/#4/#5) were not in that
list, and they are the largest single source of restatement.

---

## 3. Issue representations — 17, not 6

| # | Symbol / table | Path | Keys | Role | Verdict | Visibility |
|---|---|---|---|---|---|---|
| 1 | `issues` (drizzle) | `apps/server/src/migrations/schema.ts:404` | 59 | R3 | **legitimate** (physical DDL) | personal |
| 2 | `IssueRow` | `apps/server/src/store/types.ts:201` | 59 | R3 | **legitimate role, hand-restated** | personal |
| 3 | `IssueWire` | `packages/protocol/src/messages/issues.ts:155` | 78 | R4 | **legitimate role, hand-restated**, and **the one D7.1 non-compliance**: `sessions: z.array(SessionMeta)` (line 284) | personal |
| 4 | `IssuePatch` | `apps/server/src/modules/issues/service/types.ts:302` | 35 (picked) | command input | **COMPLIANT REFERENCE** — `Partial<Pick<IssueRow, …>>`. The pattern §6 generalizes | personal |
| 5 | `CreateIssueInput` | same file | 23 | command input | **drifted duplicate** — hand-restates create fields instead of picking | personal |
| 6 | `IssueTreeNode` | same file | 18 | R4 | **legitimate role**; embeds `IssueTreeSession[]` (a second D7.1-shaped embed, server-side) | personal |
| 7 | `TreeNode` (CLI) | `packages/issue-client/src/commands.ts` | 16 | R4 (CLI) | **drifted duplicate of #6** — hand copy; drops `id`/`type`, keeps everything else | personal |
| 8 | `ShowWire` (CLI) | same file | 22 | R4 (CLI) | **legitimate role, hand-restated** ("the slice of an issue wire the show renderer reads"); embeds `ShowSession[]` — a third session embed | personal |
| 9 | `OrphanIssue` | `packages/protocol/src/messages/issues.ts:374` | 4 | R4 | **legitimate** (narrow wire projection) | personal |
| 10 | `IssueGraphNode` | same file:333 | 8 | R4 | **legitimate** (graph projection) | personal; **edge display is open — O2** |
| 11 | `HandoffIssue` | `packages/domain/src/machine-selection.ts` | 2 | R5 | **legitimate** (branch + worktree for target pick) | personal (worktree fact **inherited** from machine) |
| 12 | `RefIssueLike` | `apps/web/src/lib/ref-miniview.ts` | 22 | R5 | **legitimate role, hand-restated** — the largest client-side restatement in the repo (22 keys) | personal |
| 13 | `FocusIssueInfo` | `apps/server/src/modules/superagent/global.ts` | 4 | R5 | **legitimate** | personal |
| 14 | `IssueInfo` | `apps/server/src/modules/workflows/service.ts` | 4 | R5 | **drifted duplicate** — same job as #13 with a different key set | personal |
| 15 | `StartableIssueLike` | `apps/web/src/features/issues/issue-startable.ts` | 4 | R5 | **legitimate** (structural predicate port) | personal |
| 16 | `IssueAutoArchiveObservation` | `packages/protocol/src/maintenance.ts` | 6 | R4 | **legitimate** (steward observation payload) | personal |
| 17 | `GitProbeTarget` | `apps/server/src/modules/issues/git-state.ts` | 8 | R5 | **legitimate** — but it is a **machine fact** port (`cwd`, `branch`, `refsPattern`, `commits`, `touched`, `shared`): visibility **inherited** from the machine, not classified per field | inherited (owned-compute) |
| — | `IssueRow` (web) | `apps/web/src/features/issues/issue-hierarchy.ts` | wraps | UI chrome | **not counted** — wraps `issue: IssueWire` + depth/expanded, redeclares nothing. ADR 4 §1.2's judgement holds at this tip | personal |
| — | `WireIssue` ×3 | `tests/e2e/browser/*.browser.e2e.ts` | 4–6 | test fixture | **not counted**; recorded so POD-368's audit does not rediscover them | n/a |
| — | `LinearIssue` | `apps/server/src/linear.ts` | 5 | foreign | **legitimate** — an external system's shape, deliberately not ours | n/a |

**Field groups (sub-objects), legitimately shared and already composed:** `IssuePanel` /
`IssuePanelTodo` / `IssuePanelArtifact` / `IssuePanelDeferred`, `IssueDepWire`, `IssueComment`,
`IssueSessionSummary`, `IssueGitState`, `IssueColor`, `IssueStage`, `IssueType`. These are the
model for what §6 asks POD-365 to do at the *entity* level.

**Count.** **17 named issue representations**, of which **3 are drifted duplicates** (#5, #7,
#14) plus the hand-restated mirrors (#2, #3, #8, #12). ADR 4 §1.2's "≥7" is confirmed and extended.

---

## 4. How to read the field map

The map in §5 has one row per **fact**, not per key spelling. Columns:

| Column | Meaning |
|---|---|
| **Fact** | The authoritative meaning, in one sentence. |
| **Carried by** | Which representations declare it (counts from the generated matrix: 135 distinct session keys across 24 measured shapes; 91 distinct issue keys across 16). |
| **Writer** | ADR 1's role class: `operator` (human), `agent-session`, `daemon`, `system`, or `derived` (no writer — computed). |
| **Class** | ADR 4 disposition: **shared** (belongs in a common field schema) · **projection-local** (legitimately one representation) · **derived** (computed, never stored twice — D7.2/D7.4) · **per-user state** (`(userId, entityId)`, D10) · **reserved `op-stream`** (ADR 1 Am1 D12 — not built) · **envelope** (provenance, D3.8) · **live-only** (R2, not durable). |
| **Visibility** | ADR 9 D3 class. Blank is not permitted: unclassifiable ⇒ `personal`/private (D4). `inherited` = a machine fact (D3 rule 3). |
| **Attribution** | Which half of the (actor, on-behalf-of) pair it carries **today**, and which it will **need** (ADR 9 D5 A3). |

Every session and issue representation in §2/§3 is `personal` (ADR 1 Am1 §3 §2/§3), so the
visibility column varies only where a field is per-user state, a machine fact, or substrate.

---

## 5. Field → authoritative meaning map

### 5.1 Session — identity, placement, naming

| Fact | Key(s) today | Carried by | Writer | Class | Visibility | Attribution |
|---|---|---|---|---|---|---|
| The session's stable Podium identity | `sessionId` (18 reps) / `id` (`sessions`, `SessionRow`) | 20 | server at spawn | **shared** — `SessionId` brand | personal | — |
| Which harness CLI runs inside it | `agentKind` (17 reps) / `agent` (`CloudAgentSourceSession`) | 17 | server at spawn (immutable) | **shared** (`AgentKind`) | personal | — |
| The agent's live working directory | `cwd` (14 reps) | 14 | daemon (`sessionCwd`, hook-observed) | **shared** | personal (path is a machine fact ⇒ **inherited** for exposure) | actor = daemon; needs no on-behalf-of |
| Which machine it runs on | `machineId` (10 reps) / `machine` (`SessionStatusResult`, `StatusWire`) / `sourceMachineId` (handoff) | 12 | server on adoption | **shared** (`MachineId`) | **inherited** (owned compute, ADR 9 D6) | — |
| Machine display label | `machineName` (`SessionMeta`, `ApprovalWire`) | 2 | **derived** (join on `machines`) | **derived** | inherited | — |
| Live terminal title | `title` (11 reps) | 11 | daemon (OSC title) | **shared** | personal | actor = daemon |
| Curated display name | `name` (10 reps) / `label` (`IssueTreeSession`, `ShowSession`) / `durableLabel` (4 reps) | 12 | operator **or** agent-session | **shared** | personal | **`nameSource` is the attribution** — see §9 |
| WHO named it | `nameSource: 'user'\|'agent'` (5 reps) | 5 | server (stamped) | **shared** | personal | **role-level only today; needs the pair** (§9) |
| Title-lock latch (a non-generic title freezes agent retitling) | `titleLocked` | `SessionDurableState` **only** | server | **live-only** (no column) | personal | — |
| Spawn-time model / effort / account selection | `model`, `effort`, `accountId` / `account` (CLI) | 9 / 7 / 4 | operator at spawn (resolved server-side) | **shared** | personal (`accountId` names a **secret**-class row; the id is not the secret) | — |
| Model / effort actually OBSERVED on turns | `observedModel`, `observedEffort` | `SessionDurableState`, `SessionMeta` | daemon (transcript) | **live-only** (no column; re-learned from the tail on reattach) | personal | actor = daemon |
| Agent's self-chosen identity colour | `agentColor` | `SessionDurableState`, `SessionMeta` | agent-session (`/color`) | **live-only** (no column) | personal | actor = agent |
| PTY geometry | `geometry` (5 reps) **vs** `terminalCols`+`terminalRows` (`sessions` DDL) | 6 | daemon | **shared** (`Geometry`) | personal | — |
| Native resume ref | `resume: ResumeRef` (10 reps) **vs** `resumeKind`+`resumeValue` (DDL, `SessionRow`) **vs** `resumeRef: string` (`CloudAgentSourceSession`) **vs** `resume: {value}` (`LakeReadSession`) | 12 | daemon (`sessionResumeRef`) | **shared** (`ResumeRef`) | personal | actor = daemon; `confidence`+`ackRequested` ride the frame, not the entity |
| Whether a resume is possible at all | `resumable` | `SessionMeta` only | **derived** (`resume != null`) | **derived** | personal | — |
| How the session came to exist | `origin: SessionOrigin` (union) **vs** `originKind`+`conversationId` (DDL, `SessionRow`) | 4 | server at spawn | **shared** | personal | — |
| Stable Podium conversation identity | `conversationPodiumId` | `SessionDurableState`, `SessionMeta` | **derived** (lookup in `conversation_identities`) | **derived** | personal | — |
| Headless (no PTY) | `headless` (4 reps) + `HeadlessFields` | 5 | server at spawn | **shared** | personal | — |
| Attached issue | `issueId` (9 reps) | 9 | operator / agent (`issue attach`) | **shared** (`IssueId`) | personal | needs pair (who attached) |
| Permanent birth nice-name inputs | `refIssueId`, `refLetter`, `refDraft` (5 reps each) | 5 | server (allocated once) | **shared** | personal; **`refLetter` allocation is an existence-leak surface — §10** | — |
| Human-facing session ref | `displayRef` (4 reps) | 4 | **derived** (repo prefix + ref fields) | **derived** | personal | — |
| WHO created it | `spawnedBy: string` (5 reps) — freeform `'user' \| 'superagent:<id>' \| 'issue:<id>' \| 'session:<id>'` | 5 | server at spawn | **shared** | personal | **actor half only, untyped and unbranded — the worst attribution site (§9)** |
| Workflow coordination pass-through | `workflowRunId`, `workflowStepId`, `executionProfileId` (4 reps each) | 4 | external coordinator at spawn | **shared** (opaque; substrate never interprets) | personal | creator gap — §9 |

### 5.2 Session — lifecycle, runtime, attention

| Fact | Key(s) today | Carried by | Writer | Class | Visibility | Attribution |
|---|---|---|---|---|---|---|
| PTY/process status | `status` (11 reps) | 11 | daemon | **shared** (`SessionStatus`) | personal | actor = daemon |
| Exit detail | `exitCode`, `spawnFailure` (5 reps each) | 5 | daemon | **shared** | personal | actor = daemon |
| Terminal-transition metadata | `stoppedAt`, `stopReason` (5 reps each) | 5 | server | **shared** | personal | — |
| Harness-observed agent phase | `agentState: AgentRuntimeState` (4 reps) **vs** flattened `phase: string` (`IssueTreeSession`, `ShowSession`, `SessionStatusResult`, `StatusWire`, `ConciergeSessionInfo`) | 9 | daemon (fenced observations, SP-cdb2) | **shared** (whole group) | personal | actor = daemon |
| Cumulative working time | `workingMsTotal` — **a member of `AgentRuntimeState` on the wire but a column on `sessions`**; `incomingWorkingMsTotal` is a live reconciliation twin | 5 | daemon | **shared**, one home only (§5.5 D-11) | personal | — |
| Native subagent fan-out | `nativeSubagentCount`, `nativeSubagents`, `awaitingSubagents` (inside `AgentRuntimeState`); `nativeSubagentCount` also flat on `SessionStatusResult`/`StatusWire` | 3 | daemon | **shared** | personal | — |
| Shell activity (uninstrumented kinds) | `busy` (`SessionMeta`) ← `shellBusy`, `shellCommandRunning` (`SessionDurableState`) | 3 | daemon (debounced) | **derived** from live state | personal | — |
| Live attach state | `controllerId`, `clientCount`, `epoch` | `SessionMeta` only | server (connection layer) | **live-only** (ADR 7 stream plane) | personal | **`controllerId` is a connection id, not a person — Phase 5 (§9)** |
| Recency / hibernation signals | `lastActiveAt` (7, ISO) · `lastInputAt` (4, ISO) · `lastOutputAt`, `lastResumedAt` (3, ISO) **vs** `lastInputAtMs`/`lastOutputAtMs`/`lastResumedAtMs` (`HostSessionView`, epoch ms) **vs** `inputAtMs`/`outputAtMs`/`resumedAtMs` (`SessionDurableState`) | 7 | daemon | **shared**, ONE clock (ADR 4 D3 rejected-alt: no ISO/epoch twins) | personal | — |
| Activity counters | `inputCount`, `outputCount`, `activityCount` (4 reps) + `activityDirty` (live) | 4 | daemon | **shared** | personal | — |
| Transcript capability | `transcriptAvailable` | `SessionDurableState`, `SessionMeta` | server (tail owner) | **live-only** (no column) | personal | — |
| Work lifecycle (kanban) | `workState: WorkState` (5 reps) | 5 | operator | **shared** — **shared session fact** (`exp-rev`), per ADR 1 Am1 D10; **open question recorded, not answered (§7.2)** | personal | needs pair |
| Retirement | `archived` (6 reps) | 6 | operator / steward (`system`) | **shared** — shared session fact (`exp-rev`); **open question recorded (§7.2)** | personal | needs pair |
| Read state | `readAt` (6 reps), `unread` (`SessionMeta`, derived from it) | 6 | the reading user | **per-user state** → POD-1076 | **per-user-state** | on-behalf-of = the reader (implicit in the key) |
| Snooze | `snoozedUntil` (`SessionDurableState`, `SessionMeta`) ← `snoozes` table (PK `session_id`) | 3 | the snoozing user | **per-user state** → POD-1076 | **per-user-state** | key carries it |
| Composer draft body + edit time | `session_drafts` table; `draftUpdatedAt` on `SessionDurableState`/`SessionMeta`; `draft: boolean` on `SessionStatusResult`/`StatusWire`; `draftSyncEngine`/`draftSync` capability flags | 5 | operator **and** agent (bidirectional sync) | **reserved `op-stream`** — NOT per-user state, NOT ordinary whole-body field-LWW (§8) | personal | needs pair per op |
| Queued agent messages | `queuedMessageCount` (`SessionDurableState`, `SessionMeta`) ← `queued_messages` | 2 | server | **derived** (count) | personal; **count is an existence-leak surface — §10** | — |
| Agent action offer | `offer: SessionOffer` ← `offers` table | 2 | agent-session | **shared** (ephemeral) | personal | actor = agent; needs on-behalf-of |
| Unacked mail | `unackedMessages` | `SessionStatusResult`, `StatusWire` | **derived** (count over `messages`) | **derived** | personal; **count leak — §10** | — |
| In-flight handoff overlay | `handoffTarget` | `SessionDurableState`, `SessionMeta` | server | **live-only** (transient overlay) | personal | — |
| Tombstone | `deletedAt`, `deletionSource`, `deletedByIssueId` | `sessions`, `SessionRow` | server | **shared** | personal | **`deletionSource` is a PATH label (`'issue'\|'standalone'`), not an actor — needs both halves (§9)** |
| Node⇄hub provenance | `viaHub`, `upstreamStale` | `SessionMeta` | server (ingest) | **envelope** (ADR 4 D3.8) — leaves the entity | inherits enveloped entity | — |

### 5.3 Session — portable export and CLI-only projections

| Fact | Key(s) | Class | Notes |
|---|---|---|---|
| Bundle format + payload layout | `format`, `transcriptFilename`, `transcriptRelativeDir`, `bundleBase`, `snapshotSha`, `snapshotFlattened`, `headSha` | **projection-local** (R6) | Legitimately only on `HandoffManifest`. |
| Worktree geometry of the export | `worktreeName`, `worktreeRelativePath`, `cwdSubpath`, `branch`, `repoId` | **shared** with repo/worktree vocabulary | Worktree facts are **machine facts** ⇒ visibility **inherited** (ADR 9 D3 rule 3). |
| Who exported it and when | `sourceMachineId`, `exportedAt` | **shared** attribution | **Device-level only today. Needs the pair (§9).** ADR 1 Am1 §9: accept is denied without `use` on the target machine. |
| Git/working-tree read-outs on a status call | `commits`, `files` | **derived** (never stored) | Also on `GitProbeTarget`/`IssueGitState` for issues — same fact, two derivation sites. |
| Issue context on a status call | `issue: {seq, stage, title, todos}` | **derived** cross-entity join | **D7.1 pressure**: a nested foreign-entity object. It is a *read-model*, not a feed shape, so it is legal only because it never rides the feed. Must stay off the wire. |
| Card presentation | `subtitle`, `issueLabel`, `summary`, `group`, `dotTone`, `queuedCount` | **projection-local** (viewmodel) | Correct as-is. |

### 5.4 Issue field map

| Fact | Key(s) today | Carried by | Writer | Class | Visibility | Attribution |
|---|---|---|---|---|---|---|
| Identity | `id` (10 reps) | 10 | server | **shared** (`IssueId`) | personal | — |
| Repo identity / display path | `repoId` (4) + `repoPath` (6) + `prefix` (2) | 6 | server (registry) | **shared** (`RepoId`) | **inherited** (repo = per-machine fact, ADR 9 D3 rule 3) | — |
| Per-repo sequence + human ref | `seq` (10), `displayRef` (2), `ref` (`OrphanIssue`) | 10 | server (allocated) | `seq` **shared**; `displayRef`/`ref` **derived** | personal; **allocation is an existence leak — §10** | — |
| Human summary | `description` (8 reps) | 8 | operator (and agents) | **reserved `op-stream`** (ADR 1 Am1 D12 named set) — §8 | personal | needs pair per op |
| Agent-facing handoff | `brief` (5 reps) | 5 | operator / agent | **shared** (ordinary field) | personal | needs pair |
| Free-form notes | `notes` (3), `activityNotes` (4) + `notesUpdatedAt` (4), `design`, `acceptance`, `dependencyNote`, `suggestedReason` | 4 | operator / agent / assistant (`system`) | `notes` → **reserved `op-stream`** (named set); the rest **shared** | personal | needs pair |
| Title | `title` (11 reps) | 11 | operator / agent | **shared** | personal | needs pair |
| Lifecycle stage | `stage` (11 reps) + `suggestedStage` (3) + `closed` (`IssueTreeNode`, `TreeNode`) | 11 | operator / agent | **shared** (`IssueStage`); `closed` is **derived** | personal | needs pair (the close actor — §9) |
| Closure | `closedReason` (6), `closedAt` (3) | 6 | operator / agent | **shared** | personal | **the close actor is unrecorded — §9** |
| Deferral | `deferUntil` (3), `deferred` (`IssueWire`, derived) | 3 | operator | **shared** / **derived** | personal | needs pair |
| Priority, type, assignee, labels, estimate | `priority` (9), `type` (6), `assignee` (8), `labels` (3, ← `issue_labels`), `estimateMin` (3) | 9 | operator / agent | **shared** | personal | needs pair; `assignee` is a **free-text name today and becomes a `UserId` under POD-1075** |
| Graph edges | `parentId` (5), `blockedBy` (4 — **LLM prose, not edges**), `deps`/`dependents` (`IssueWire`, ← `issue_deps`), `blocksDeps` (`IssueTreeNode`,`TreeNode`), `supersededBy` (3), `duplicateOf` (3), `children`/`omittedChildren` (tree) | 9 | operator / agent | `parentId`/`supersededBy`/`duplicateOf` **shared**; `deps`/`dependents`/`blocksDeps`/`children` **derived** (D7.1: reference by branded id, never embed) | personal; **cross-boundary edge display is O2; edges are existence leaks — §10** | needs pair |
| Readiness | `ready` (6), `blocked` (6), `childCount`/`childDoneCount` (2 each) | 6 | **derived** | **derived** (D7.4 candidate — a rollup over data the client may not hold once scoped) | personal; **counts leak — §10** | — |
| Workspace | `worktreePath` (8), `branch` (8), `parentBranch` (5) | 8 | server / daemon | **shared**, but **machine facts** | **inherited** (owned compute); **"this worktree is in use" is an existence leak — §10** | — |
| Agent launch defaults | `defaultAgent`, `defaultModel`, `defaultEffort` (5 each), `machineId` (6) | 6 | operator | **shared** — the SAME fields harness-scoped defaults and model overrides resolve through (resolution logic, not new vocabulary) | personal; `machineId` **inherited** | — |
| Needs-human group | `needsHuman` (6), `humanQuestion` (6), `humanQuestionOptions` (3), `humanQuestionAskedBy` (3), `humanQuestionAskedAt` (3) | 6 | agent-session raises; **server stamps `askedBy`** | **shared** — one field group (ADR 4 D3.1's named example) | personal; **routing becomes per-user (ADR 9 D8 S3)** | **`askedBy` = actor half, server-authoritative and verified against `actorSessionId` (`registry.ts:1198-1215`). Needs the on-behalf-of half (§9)** |
| Agent-published panel | `panel: IssuePanel` (3) — todos / artifacts / deferred | 3 | agent-session | **shared** (composed group) | personal; artifacts inherit the issue | needs pair |
| Colour | `color: IssueColor` (5) | 5 | operator | **shared** (slot name, never a hex) | personal | — |
| Manual order | `sortKey` (3) | 3 | operator | **shared** (per-sibling-scope key space) | personal | needs pair |
| Pin | `pinned` (3, on `issues`) **vs** `pins` table (PK `(kind,id)`) | 3 | the pinning user | **per-user state** → POD-1076 | **per-user-state** | key carries it |
| Read state / tuck-away | `readAt` (4), `unread` (derived), `tuckedAt` (3) | 4 | the reading user | **per-user state** → POD-1076 (`tuckedAt` is explicitly documented "GLOBAL (single-operator, like `readAt`)") | **per-user-state** | key carries it |
| Intent + audience | `origin: 'human'\|'agent'` (4), `audience: 'human'\|'agent'` (4) | 4 | server (caller-derived) | **shared** | personal | **role-level attribution; the `origin` key COLLIDES with session `origin` (§5.5 D-2)** |
| Draft vessel | `draft: boolean` (4) | 4 | server | **shared** | personal | **key collides with session composer-`draft` (§5.5 D-2)** |
| Coordinator + creator session | `coordinatorSessionId` (4), `startedBySession` (4) | 4 | server (stamped from actor) | **shared** | personal | **actor half only; needs on-behalf-of (§9)** |
| Linear mirror | `linearId`, `linearIdentifier`, `linearUrl` (3 each), `linear` (`CreateIssueInput` nested) | 3 | server (integration) | **shared** | personal | — |
| External PR | `prUrl` (3) | 3 | agent / operator | **shared** | personal | — |
| Timestamps | `createdAt`, `updatedAt` (3 each) | 3 | server | **shared** | personal | — |
| Archive / tombstone | `archived` (6), `deletedAt` (6) | 6 | operator / steward | **shared** | personal | needs pair |
| Embedded sessions | `sessions: SessionMeta[]` (`IssueWire`) · `IssueTreeSession[]` (`IssueTreeNode`) · `ShowSession[]` (`TreeNode`, `ShowWire`) | 4 | **derived** | **derived — D7.1 NON-COMPLIANCE ×4** (§5.5 D-4) | personal | — |
| Session rollup | `sessionSummary: {total, byPhase}` (`IssueWire`) | 1 | **derived** | **derived**; **D7.4 materialized-entity candidate** once the feed is scoped | personal; **count leak — §10** | — |
| Git state | `gitState: IssueGitState` (`IssueWire`), `GitProbeTarget` | 2 | **derived** at serialization ("never persisted") | **derived**; machine fact | **inherited** | — |
| Comments | `comments` (deprecated, `IssueWire`), `commentCount` (2) ← `issue_comments` | 2 | commenting principal | separate entity; `commentCount` **derived** | personal (own owner per ADR 1 Am1 §3) | comment author needs the pair |
| Node⇄hub provenance | `viaHub`, `upstreamStale`, `pendingSync` (`IssueWire`) | 1 | server (ingest) | **envelope** (D3.8) | inherits entity | — |
| Command-input-only | `startNow` (`CreateIssueInput`), `id` (client-supplied optimistic id) | 1 | caller | **projection-local** (command input) | personal | — |

### 5.5 The disagreement catalogue

Every entry is a concrete, addressable defect. This is the list POD-365/366/367 close.

| # | Disagreement | Kind | Sites |
|---|---|---|---|
| **D-1** | **Same fact, different key name.** `agentKind`→`agent`; `machineId`→`machine`; `accountId`→`account`; `resume`→`resumeRef`; `name`/`title`→`label`; `sessionId`→`id`; `displayRef`→`ref`; `agentState.phase`→`phase`; `name`→`durableLabel` | renamed fact | `CloudAgentSourceSession`, `SessionStatusResult`/`StatusWire`, `IssueTreeSession`/`ShowSession`, `sessions`/`SessionRow`, `OrphanIssue` |
| **D-2** | **Same key name, DIFFERENT fact.** `origin` = spawn/resume union on sessions but `'human'\|'agent'` intent on issues · `draft` = "a composer draft exists" on `StatusWire` but "placeholder vessel" on issues · `type` = message discriminant on frames but `IssueType` on issues · `blockedBy` = LLM prose notes but reads as the dependency graph (the column comment says so explicitly) · `archived` on both entities with different writers | colliding vocabulary | 5 collisions; each is a live misreading hazard for POD-365 |
| **D-3** | **Same fact, different type.** `resume`: `ResumeRef` \| `resumeKind`+`resumeValue` (two columns) \| `string` \| `{value}` — **four encodings** · `geometry`: `Geometry` \| `terminalCols`+`terminalRows` · `origin`: union \| `originKind`+`conversationId` | encoding split | ADR 4 §4.1 names the last two; the `resume` quadruplication is new here |
| **D-4** | **Entity-in-entity embedding (ADR 4 D7.1).** `IssueWire.sessions: SessionMeta[]` is the canonical non-compliance — **but there are four embed sites, not one**: `IssueWire.sessions`, `IssueTreeNode.sessions`, `TreeNode.sessions`, `ShowWire.sessions` | O(world) fan-out | Only the first rides the feed; the other three make the *same* mistake in read models and would re-seed it |
| **D-5** | **A fact derived in one place, stored in another.** `resumable` (derived) vs `resume` (stored) · `unread` (derived) vs `readAt` (stored) · `closed` (derived) vs `closedReason`/`stage` (stored) · `deferred` vs `deferUntil` · `displayRef` vs `refIssueId`/`refLetter`/`prefix` · `blocksDeps`/`deps` vs `issue_deps` | derived/stored twin | 6 pairs; each must become a documented pure function (D3.6) |
| **D-6** | **ISO vs epoch-ms twins of the same instant.** `lastInputAt`/`lastOutputAt`/`lastResumedAt` (ISO) vs `lastInputAtMs`/`lastOutputAtMs`/`lastResumedAtMs` (`HostSessionView`) vs `inputAtMs`/`outputAtMs`/`resumedAtMs` (`SessionDurableState`) — **three spellings of one clock** | twin clock families | ADR 4 D3 rejected-alternatives explicitly forbids this ("ISO and epoch dual semantics in model") |
| **D-7** | **Hand-copied read models.** `StatusWire` ≡ `SessionStatusResult` (15 keys, key-for-key, comment admits the source) · `TreeNode` ≈ `IssueTreeNode` · `ShowSession` ≈ `IssueTreeSession` · `BtwSessionInfo` ⊂ `ConciergeSessionInfo` | hand restatement | 4 pairs. Every one is a CLI/server boundary that a `Pick` would have made free |
| **D-8** | **Three parallel session field lists inside one file.** `Session` (41) / `SessionInit` (42) / `SessionDurableState` (44) in `session.ts` | hand restatement | The single largest restatement site; not in ADR 4 §1.2's inventory |
| **D-9** | **Wire fields with no durable home.** `agentColor`, `observedModel`, `observedEffort`, `transcriptAvailable`, `titleLocked` have **no column in any migration** — verified: `grep -c agent_color apps/server/src/migrations/*` = 0. They are published on `SessionMeta` and re-learned from the transcript tail on reattach | live-only masquerading as durable | 5 fields. R2, not R1 (ADR 4 D3.7) — must be declared as such, not quietly added to the aggregate |
| **D-10** | **Per-user state modelled as instance singletons.** `readAt` on `sessions`+`issues`+`issue_messages`, `snoozes` PK `session_id`, `pins` PK `(kind,id)`, `tab_order` PK `worktree`, `session_drafts` PK `session_id`, `tuckedAt` on `issues` — six keying conventions, each asserting there is exactly one person | multi-user shape defect | → §7 / POD-1076 |
| **D-11** | **One fact, two homes across the R3/R4 split.** `workingMsTotal` is a member of `AgentRuntimeState` on the wire and a **column on `sessions`**; `incomingWorkingMsTotal` is a third, live reconciliation copy. Separately, `AgentRuntimeState` persists as `turnState` inside `session_observation_checkpoints` — so agent state has **no column on `sessions` at all** while one of its members does | split home | Must resolve to one home in the R1 aggregate |
| **D-12** | **The spawn tuple is restated in four places.** `SpawnMessage`, `SessionInit`, `HandoffExportRequestMessage`, and `ApprovalOp`'s `automation-schedule` → `target: {kind:'fresh', repoPath, agentKind, model?, effort?}` (`packages/protocol/src/messages/approvals.ts`) | hand restatement | The approval-op member is the 1.4 candidate the brief flagged; confirmed present |
| **D-13** | **Provenance carried as entity payload.** `viaHub`, `upstreamStale` on `SessionMeta`; `viaHub`, `upstreamStale`, `pendingSync` on `IssueWire` | envelope violation (D3.8) | → `ReplicatedEnvelope<T>` (POD-304) |
| **D-14** | **Unbranded ids everywhere.** `sessionId`, `issueId`, `machineId`, `repoId`, `refIssueId`, `coordinatorSessionId`, `startedBySession`, `humanQuestionAskedBy`, `spawnedBy`, `targetSessionId`, `sourceMachineId` are all raw `z.string()` / `string` in model-adjacent schemas | brand gap (D3.5) | POD-301/POD-360 own the sweep; recorded here because the *meaning* map is where the brand belongs |
| **D-15** | **Attribution stamped from a role, a device, or a path label — never a person.** `nameSource`, `deletionSource`, `spawnedBy`, `humanQuestionAskedBy`, `startedBySession`, `coordinatorSessionId`, `controllerId`, `sourceMachineId`/`exportedAt`, `assignee` (free text), and the close/unblock actor (**not recorded at all**) | attribution gap | → §9 |
| **D-16** | **Anonymous projections.** 29 inline object literals in `router.ts` alone carry `sessionId:` in a return position | unnamed restatement | → §6.5 |

---

## 6. The composition plan (what POD-365 lands)

ADR 4 D1: **not one universal record.** The plan is one *vocabulary* — named field schemas in
`packages/model` — plus per-role types that `Pick` from them. Names below are proposals; the
grouping is the deliverable.

### 6.1 Cross-entity schemas — defined ONCE, composed by every owned class

These four exist once for the whole model. They are **not** restated per entity, and they are
the only place POD-1075's new vocabulary appears.

| Schema | Members | Source of truth | Composed by |
|---|---|---|---|
| **`Ownership`** | `owner: UserId` · `visibility: VisibilityClass` (`personal` \| `per-user-state` \| `owned-compute` \| `deployment-substrate` \| `secret`) | **POD-1075** defines the types; ADR 9 D2/D3 define the meanings; ADR 1 Am1 §3 fills the per-class values | Session R1, Issue R1, and every other owned aggregate. **Not** on R5 ports, **not** on the envelope (ADR 4 Am1 D9.4: ownership is durable truth, provenance is per-delivery) |
| **`GrantEdge`** | `(entityRef, granteeUserId, verb)`; verbs `read`/`write` for personal classes, `see`/`use`/`manage` for owned compute | **POD-1075**; ADR 9 D2 | Its **own** aggregate — a grant is an entity, not a field on the granted row. Sessions/issues reference it by id, never embed it (D7.1) |
| **`Attribution`** | `actor: ActorRef` (agent-session identity or `system`) · `onBehalfOf: UserId \| null` (null **only** for the `system` principal) | ADR 9 D5 A3; shape per ADR 4 Am1 D9.3 — **two differently branded fields, never collapsed** | Every attributing field group (§9). Both stamped from the transport principal (ADR 3 D7), never from payload |
| **`PerUserKey`** | `userId: UserId` · `entityId: <EntityId>` | ADR 4 Am1 D10 — **one** fragment, not one per feature | Every per-user-state aggregate (§7) |

**Coordination with POD-1075 (required before POD-365 starts).** This plan asserts exactly four
things about POD-1075's output, and nothing more: (a) `UserId` is a brand in the POD-301 family;
(b) `VisibilityClass` is the closed five-value enum of ADR 9 D3, with no sixth member and no
free-form predicate; (c) the grant edge is its own aggregate keyed
`(entityRef, granteeUserId, verb)` with a closed verb set; (d) `ActorRef` is distinct from
`UserId` so `Attribution` cannot degrade into one nullable id. If POD-1075 lands a different
shape for any of the four, §6.1 is the row to change — not the per-entity tables below, which
only reference these names. Mailed to POD-1075 alongside this document.

### 6.2 Session field schemas

| Schema | Members | Class | Notes |
|---|---|---|---|
| `SessionIdentity` | `sessionId: SessionId` · `agentKind: AgentKind` · `createdAt` · `origin: SessionOrigin` · `headless: boolean` | shared | Resolves **D-1** (`id`/`sessionId`, `agent`/`agentKind`) and **D-3** (`origin` one encoding; `originKind`+`conversationId` become an R3 mapping detail) |
| `SessionPlacement` | `cwd` · `machineId: MachineId` · `issueId: IssueId \| null` | shared; `machineId` visibility **inherited** | Placement writes are additionally gated by `use` on the target machine (ADR 1 Am1 §3 §2, D13.7) |
| `SessionLaunchConfig` | `model` · `effort` · `accountId` · `durableLabel` | shared | **The spawn tuple.** One definition retires **D-12**'s four restatements, including `ApprovalOp`'s `automation-schedule` → `target.fresh` |
| `SessionNaming` | `title` · `name` · `nameSource: 'user' \| 'agent'` | shared | `nameSource` is attribution — §9 gives it the pair. Retires `label` and `durableLabel`-as-a-name (**D-1**) |
| `SessionRef` | `refIssueId: IssueId \| null` · `refLetter` · `refDraft` | shared | `displayRef` is **derived** from these + repo prefix, never stored (**D-5**) |
| `SessionResume` | `resume: ResumeRef` | shared | **One** encoding. Retires all four of **D-3**'s spellings; `resumable` becomes derived |
| `SessionLifecycle` | `status: SessionStatus` · `exitCode` · `spawnFailure` · `stoppedAt` · `stopReason` · `archived` | shared (`archived` = shared session fact, `exp-rev`) | `closed`-style booleans stay derived |
| `SessionActivity` | `lastActiveAt` · `lastInputAt` · `lastOutputAt` · `lastResumedAt` · `inputCount` · `outputCount` · `activityCount` | shared | **One clock representation** (ADR 4 D3 rejected-alt). Epoch-ms views are an **adapter at the port**, not a second field family — retires **D-6** |
| `AgentRuntimeState` | `phase` · `since` · `workingMsTotal` · `nativeSubagentCount` · `nativeSubagents` · `awaitingSubagents` · `idle` · `need` · `error` | shared group | `workingMsTotal` gets **one** home here; the `sessions.working_ms_total` column becomes its R3 encoding and `incomingWorkingMsTotal` a mapping local (**D-11**) |
| `SessionWorkState` | `workState: WorkState` | shared (`exp-rev`) | Shared session fact per ADR 1 Am1 D10; **open question recorded in §7.2** |
| `SessionWorkflowLink` | `workflowRunId` · `workflowStepId` · `executionProfileId` | shared, opaque | Substrate never interprets them |
| `SessionTombstone` | `deletedAt` · `deletionSource` · `deletedByIssueId` | shared | `deletionSource` gains the pair (§9) |
| `SessionLiveOverlay` (**R2 only**) | `controllerId` · `clientCount` · `epoch` · `busy` (← `shellBusy`, `shellCommandRunning`) · `handoffTarget` · `titleLocked` · `agentColor` · `observedModel` · `observedEffort` · `transcriptAvailable` · `geometry` (live authority) · `activityDirty` | **live-only** | Declared live/ephemeral per D3.7. This is where **D-9**'s five column-less fields belong; they may appear on R4 **documented as a live overlay**, never as R1 members |
| `SessionDerived` | `displayRef` · `resumable` · `unread` · `machineName` · `conversationPodiumId` · `queuedMessageCount` | **derived** | Pure functions over R1 (+ live inputs). Never a second write path (D3.6) |

### 6.3 Issue field schemas

| Schema | Members | Class | Notes |
|---|---|---|---|
| `IssueIdentity` | `id: IssueId` · `repoId: RepoId` · `seq` | shared; `repoId` **inherited** | `prefix`, `displayRef`, `ref`, `repoPath` all **derived** from the repo registry (**D-5**, **D-1**) |
| `IssueText` | `title` · `brief` · `design` · `acceptance` · `activityNotes` + `notesUpdatedAt` · `dependencyNote` · `suggestedReason` | shared | **`description` and `notes` are NOT here** — §8 |
| `IssueLifecycle` | `stage: IssueStage` · `suggestedStage` · `closedReason` · `closedAt` · `deferUntil` · `archived` · `deletedAt` | shared | `closed`, `deferred`, `ready`, `blocked` are all **derived** (**D-5**) |
| `IssueTriage` | `priority` · `type: IssueType` · `assignee: UserId \| null` · `labels` · `estimateMin` · `color: IssueColor` · `sortKey` · `dueAt` | shared | `assignee` becomes a **`UserId`** under POD-1075 (free text today); `color` stays a slot name, never a hex |
| `IssueGraphRefs` | `parentId: IssueId \| null` · `supersededBy` · `duplicateOf` · `blockedByNotes: string[]` | shared | **`blockedByNotes` renames `blockedBy`** to end **D-2**'s collision with the real edge set. `deps`/`dependents`/`blocksDeps`/`children` are **derived** from `issue_deps` by branded id (D7.1) |
| `IssueWorkspace` | `worktreePath` · `branch` · `parentBranch` · `machineId: MachineId` | shared; visibility **inherited** (machine facts) | Same schema `GitProbeTarget` and `HandoffIssue` pick from |
| `IssueAgentDefaults` | `defaultAgent` · `defaultModel` · `defaultEffort` | shared | Harness-scoped defaults and issue model overrides **resolve through these** — resolution logic, not new vocabulary |
| `NeedsHuman` | `needsHuman` · `humanQuestion` · `humanQuestionOptions` · `humanQuestionAskedBy` · `humanQuestionAskedAt` | shared group | ADR 4 D3.1's own worked example. `askedBy` is the **actor** half and stays server-authoritative; §9 adds `onBehalfOf` |
| `IssuePanel` | `todos[]` · `artifacts[]` · `deferred[]` | shared group | Already composed today — keep |
| `IssueIntent` | `origin: 'human' \| 'agent'` · `audience: 'human' \| 'agent'` · `draft: boolean` | shared | **Rename on composition** to end **D-2**: `intentOrigin` / `isDraftVessel` (session `origin` and session composer-`draft` keep the unqualified names) |
| `IssueCoordination` | `coordinatorSessionId: SessionId \| null` · `startedBySession: SessionId \| null` | shared | Actor-half attribution; §9 |
| `IssueLinear` | `linearId` · `linearIdentifier` · `linearUrl` · `prUrl` | shared | External refs |
| `IssueDerived` | `ready` · `blocked` · `deferred` · `childCount` · `childDoneCount` · `commentCount` · `sessionSummary` · `gitState` · `displayRef` · `prefix` · `unread` | **derived** | `sessionSummary`/`childCount`/`childDoneCount` are **D7.4 materialized-entity candidates** once the feed is scoped: a rollup over rows a scoped client may not hold cannot be a replica-side join |

### 6.4 What each representation picks

| Representation | Role | Picks |
|---|---|---|
| `Session` R1 (new) | R1 | `SessionIdentity` + `Placement` + `LaunchConfig` + `Naming` + `Ref` + `Resume` + `Lifecycle` + `Activity` + `AgentRuntimeState` + `WorkState` + `WorkflowLink` + `Tombstone` + **`Ownership`** + **`Attribution`** |
| `sessions` (DDL) / `SessionRow` | R3 | The same set, through **one** documented `toStorage`/`fromStorage` pair that owns the encoding splits (`resume`→2 cols, `geometry`→2 cols, `origin`→2 cols) |
| `Session` (class) | R2 | R1 set (typed **from** the schemas) + `SessionLiveOverlay`. `SessionInit` becomes `Pick<SessionR1, …> & { toDaemon; onActivity }`; `SessionDurableState` becomes the mutable subset — **D-8** closes |
| `SessionMeta` | R4 | R1 set **minus** `Tombstone` **minus** per-user fields, **plus** `SessionLiveOverlay` (documented as overlay) **plus** `SessionDerived`. `viaHub`/`upstreamStale` **leave** for the envelope (**D-13**) |
| `HandoffManifest` | R6 | `Pick<SessionR1, sessionId|agentKind|resume|title|issueId>` + `IssueWorkspace` subset + bundle-local keys + `Attribution` (`exportedAt`, `sourceMachineId` + the pair) |
| `HostSessionView` | R5 | `Pick<…, sessionId|machineId|status|resume|agentState|lastActiveAt>` + an **epoch-ms adapter** for the three `*AtMs` reads |
| `SessionNoticeInfo`, `RefSessionLike`, `ResumableSession`, `HandoffSession`, `ConciergeSessionInfo`, `AnswerTargetSession`, `LakeReadSession` | R5 | Straight `Pick`s. `FocusSessionInfo` keeps `extends`. **`BtwSessionInfo` deletes** (use `ConciergeSessionInfo`) |
| `CloudAgentSourceSession` | R5 | `Pick<…, sessionId|agentKind|resume|cwd|machineId>` — **renames deleted** (**D-1**) |
| `IssueTreeSession` | R4 | `Pick<…, sessionId|agentKind|model|status> ` + derived `displayRef`, `label` (= `name ?? title`), `phase` (= `agentState.phase`), `coordinator`. **`ShowSession` deletes and imports this** (**D-7**) |
| `SessionStatusResult` | R4 | Picks + derived. **`StatusWire` deletes and imports it** (**D-7**) |
| `SessionCardModel` | viewmodel | Unchanged — already composes |
| `Issue` R1 (new) | R1 | `IssueIdentity` + `Text` + `Lifecycle` + `Triage` + `GraphRefs` + `Workspace` + `AgentDefaults` + `NeedsHuman` + `Panel` + `Intent` + `Coordination` + `Linear` + **`Ownership`** + **`Attribution`** (+ the two `op-stream` documents by reference, §8) |
| `issues` (DDL) / `IssueRow` | R3 | Same set via one `toStorage`/`fromStorage` pair (`blockedByNotes` as JSON text, `panel` as raw JSON) |
| `IssueWire` | R4 | R1 set minus per-user, **plus `IssueDerived`**, **minus `sessions`** (D7.1 — deleted at POD-308), minus provenance (**D-13**) |
| `IssuePatch` | command input | **Unchanged pattern** — `Partial<Pick<…>>`. `CreateIssueInput` converts to the same shape (**D-7**) |
| `IssueTreeNode` | R4 | Picks + derived + `sessionIds: SessionId[]` instead of embedded sessions. **`TreeNode` deletes and imports it** |
| `ShowWire`, `RefIssueLike`, `StartableIssueLike`, `FocusIssueInfo`, `GitProbeTarget`, `HandoffIssue`, `OrphanIssue`, `IssueGraphNode` | R4/R5 | Straight `Pick`s. **`IssueInfo` (workflows) deletes** in favour of `FocusIssueInfo` |
| L1 frames (54) | frames | Stay in `packages/protocol` (ADR 4 D4). Rule: **a frame's entity-shaped subset is a `Pick` from model, and the frame adds only transport keys** (`type`, `requestId`, `confidence`, `ackRequested`, chunk offsets). `DaemonAck`/`sessionResumeRef`'s `ackRequested` and `confidence` are **transport keys and stay on the frame** — they are not entity vocabulary |
| Replica collections | R4 carrier | Unchanged; carry the R4 projections verbatim |

### 6.5 Two rules that keep the plan from being re-broken

1. **A projection with no name is not a representation.** Inline object literals that build a
   session or issue shape in a return position (**D-16**: 29 in `router.ts` alone) must call a
   named mapper from model. This is what makes POD-368's audit countable.
2. **One documented mapping-function pair per entity** (ADR 4 §4.1): `toWire` / `fromWire`,
   `toStorage` / `fromStorage`. Every encoding split in **D-3** and **D-6** lives inside exactly
   one of them. Two mappers for one hop is the drift restarting.

---

## 7. Per-user state — candidates marked for extraction (POD-1076)

Per ADR 1 Am1 D10 and ADR 4 Am1 D10: an R1 aggregate keyed `(userId, entityId)` composing the
**one** `PerUserKey` fragment. Visibility class **`per-user-state`**; grants **none, by
construction**; conflict rule **`single-writer`**.

**POD-365 must NOT fold any of these back into the canonical aggregate as a singleton field.**

### 7.1 Marked for extraction — mechanical, no judgement needed

| Fact | Today's shape (verified) | Rides which wire today | Target |
|---|---|---|---|
| Session read state | `sessions.read_at` column | `SessionMeta.readAt` + derived `unread` | `(userId, sessionId)` |
| Issue read state | `issues.read_at` column | `IssueWire.readAt` + derived `unread` | `(userId, issueId)` |
| Tracker-mail read state | `issue_messages.read_at` column | inbox listing | `(userId, issueMessageId)` |
| Snooze | `snoozes` table, PK `session_id` | `SessionMeta.snoozedUntil` | `(userId, sessionId)` |
| Tuck-away | `issues.tucked_at` — comment says "SERVER-side and GLOBAL (single-operator, like `readAt`)" | `IssueWire.tuckedAt` | `(userId, issueId)` |
| Pins | `pins` table, PK `(kind, id)` | `PinState` | `(userId, pinRef)` |
| Issue pin flag | `issues.pinned` column | `IssueWire.pinned` | `(userId, issueId)` — **note it is a *second* pin mechanism; POD-1076 should collapse the two** |
| Tab order | `tab_order` table, PK `worktree` | UI state | `(userId, worktree)` |
| Sidebar / tab / pane layout | `EngineState` UI keys (`paneA`, `paneB`, `split`, `focusedPane`, `dockVisibleSession`, `openIssueId`, `selectedIssueId`, `peekIssueId`) + `ui` store | client-local | `(userId, …)` — client-local today, so this is the cheapest member |
| Personal preference keys | `PodiumSettings` (session defaults, sidebar, autoContinue, `telegramChatId`, ntfy topic) | settings | `(userId, key)`; `telegramChatId` explicitly per ADR 9 D8 S4 |
| Client outbox / replica cursor | device-local | — | `per-user-state`, device-local, never replicated (ADR 1 Am1 §10) |

### 7.2 Open questions — recorded, NOT answered here (POD-1076 owns them)

> **Q1 — Is session `archived` a shared session fact or per-user view state?**
> ADR 1 Am1 D10 decides `exp-rev` (shared) and gives the reasoning (`archived` sits beside
> `deleted_at`/`deletion_source`; it means "this session is retired"). **This inventory records
> the decision and does not reopen it** — but D10 also creates a follow-on question it explicitly
> leaves open: *once a session is shared, is a per-viewer "hide this from **my** sidebar"
> affordance wanted?* That would be a **new** per-user row, not a re-classification of
> `archived`. POD-1076 decides whether to create it.
>
> **Q2 — Is session `workState` a shared session fact or per-user view state?**
> Same disposition: D10 decides `exp-rev` on the ground that `WorkState`'s values
> (`planning|implementing|testing|done|icebox`) are claims about the *work*, identical for every
> viewer. Recorded, not reopened. The open part is the same as Q1: whether a personal board
> column ever needs to differ from the shared one.
>
> **Q3 — The composer draft body is NOT per-user state.** It is shared-surface collaborative
> text heading for the reserved `op-stream` class (§8). POD-1076 must **not** absorb it into the
> per-user family: doing so would silently delete the collaboration feature rather than defer it
> (ADR 1 Am1 D10, rejected alternative 2).

---

## 8. The reserved `op-stream` set — reserved, not built

ADR 1 Amendment 1 **D12** reserves a sixth conflict class, `op-stream`, for a **small named
set**. Membership is closed and adding to it requires an ADR 1 amendment. This inventory's only
obligation is to **stop recording these three as ordinary whole-body field-LWW**:

| Member | Where it lives today | Recorded as |
|---|---|---|
| Session **composer draft body** (+ `draftUpdatedAt`) | `session_drafts` table (PK `session_id`); `draftUpdatedAt` on `SessionDurableState`/`SessionMeta` | **reserved `op-stream`**, with D10's **named interim defect**: it keeps `field-LWW` today, and **before session sharing ships (Phase 3, POD-290) it must either move to `op-stream` or be gated to a single writer** via the existing `controllerId`/`requestControl` model. Shipping neither is out of compliance |
| Issue **`description`** | `issues.description`, `IssueWire.description` (8 reps) | **reserved `op-stream`** |
| Issue **`notes`** | `issues.notes`, `IssueWire.notes` | **reserved `op-stream`** |

**The shape constraint that must travel with them** (ADR 1 Am1 D12 part 3, protecting ADR 2 D5):
a document entity carries its **materialized value plus a bounded recent-op tail**. A document
reconstructed by replaying an unbounded op log breaks ADR 2 D5's positive-state retention proof
and requires the log-compaction ADR that ADR 2 parks. POD-365 should therefore give these three
fields a *field schema shaped for that future* — a materialized string today, with the op tail
added beside it — rather than a plain `z.string()` that has to change shape later.

**Not in the set, and must not be added by convenience:** issue `title`, `brief`, comments,
`activityNotes`, session `name`/`title` (ADR 1 Am1 D12 rejected-alt: "text fields" is not
auditable). **PTY input is explicitly excluded** — two people typing into one terminal is a
*control* problem already modelled by `controllerId` + `requestControl`.

---

## 9. Attribution — which half each field carries, and which it needs

ADR 9 D5 A3 / ADR 4 Am1 D9.3: attribution is a **pair** — `actor` (which agent) and
`onBehalfOf` (which human) — **two differently branded fields**, both stamped from the transport
principal (ADR 3 D7), **never** from payload. Every attributing field in the system today carries
**at most the actor half**, and several carry neither.

| Field | What it carries today | Verified | Needs |
|---|---|---|---|
| `humanQuestionAskedBy` | **actor** — "sessionId of the agent session that asked", raw `z.string()`. **Server-authoritative**: an agent may only attribute to its own session (`registry.ts:1198–1215` rejects a mismatch against `actorSessionId`) | ✅ | **+ `onBehalfOf`**, so "did a *person* or an agent ask this?" survives multi-user. Also brand the actor half |
| `nameSource: 'user' \| 'agent'` | **role class only** — not a person, not a session | ✅ | **+ both halves.** The human-outranks-agent rule ([spec:SP-eb60]) is an *authorization* rule that currently rides a two-value enum |
| `deletion_source: 'issue' \| 'standalone'` | **neither** — it is a *code path* label, typed as bare `text` | ✅ | **+ both halves.** The path label may stay as a separate reason field |
| `spawnedBy: string` | **actor**, as freeform prose (`'user'`, `'superagent:<id>'`, `'issue:<id>'`, `'session:<id>'`) | ✅ | **+ both halves**, branded and typed. This is the least structured attribution site in the entity vocabulary |
| `startedBySession`, `coordinatorSessionId` | **actor** (bare session id, dangling-tolerant, unbranded) | ✅ | **+ `onBehalfOf`**; brand as `SessionId` |
| Issue **close / unblock actor** | **nothing is recorded.** `closedReason` + `closedAt` exist; no actor, no on-behalf-of | ✅ (no such column on `issues`) | **both halves.** This is the clearest missing-attribution site in the tracker |
| Issue `assignee` | free-text string | ✅ | becomes a **`UserId`** (POD-1075) — it is an ownership-adjacent field, not attribution, but the same brand |
| `HandoffManifest.sourceMachineId` + `exportedAt` | **device-level only** (which machine, when) | ✅ | **+ both halves.** ADR 1 Am1 §9: accept is denied (not retargeted) without `use` on the target machine |
| `Session.controllerId` | a **connection id** — not a person | ✅ | identity on control is **Phase 5** work (ADR 1 Am1 D12 note); recorded here so the field is not mistaken for attribution |
| `IssueComment.author`, `IssueMessageRow.fromAuthor`/`claimedBy`, `MessageRow.fromKind`/`fromSession`/`fromName` | **actor** or a role class | ✅ | **+ `onBehalfOf`** (adjacent entities — POD-304's matrix rows, listed for completeness, not claimed by 1.4) |
| `IssueRow.origin` / `audience` (`'human'\|'agent'`) | **role class** | ✅ | keep as intent, but the *creating* principal's pair belongs on `Attribution`, not inferred from `origin` |
| `system`-written rows (steward, expiry, boot reconcile, derived maintenance) | nothing | — | `actor = system`, **`onBehalfOf = null`** — ADR 9 D8 S5: system principals never act *as* a person |

### 9.1 Recorded gap: scheduled automations have no creator

`AutomationWire` (`packages/protocol/src/messages/automations.ts`) carries `id`, `name`,
`enabled`, `repoPath`, `scheduleKind`, `cron`, `runAt`, `targetSessionId`, `agentKind`, `model`,
`effort`, `prompt`, `sessionMode`, `nextRunAt`, `lastRunAt`, `createdAt` — and **no creator**.
`AutomationRunWire` carries `automationId`, `firedAt`, `sessionId`, `outcome`, `detail` — also
no principal. The `automations` table (16 cols) has no owner column.

Per ADR 9 D8 **S6**, scheduled automations are **delegated like the superagent**: they run as
their creator, with that creator's **current** rights, evaluated live. They therefore need an
`onBehalfOf` they do not have. **Recorded as a gap; not implemented here.** ADR 1 Am1 §3 §7
already assigns the matrix row ("Automations / runs — owner: creating user"), so the model change
is small; it is the *absence* that is the finding.

The enums `AutomationScheduleKind` (`cron`|`once`), `AutomationSessionMode` (`fresh`|`resume`)
and `AutomationRunOutcome` (`spawned`|`missed`|`skipped_overlap`|`error`) are placed as
**automation-local vocabulary** — they are not session/issue vocabulary and do not enter the
1.4 field schemas. What *does* enter is `SessionLaunchConfig`: the `automation-schedule` approval
op's `target: {kind:'fresh', repoPath, agentKind, model?, effort?}` restates the spawn tuple and
is a **1.4 candidate** (**D-12**).

### 9.2 `FeatureState` — deployment substrate, placed and closed

`FeatureState` (`packages/protocol/src/features.ts:113`) — `listed`, `enabled`,
`source: 'config'|'user'|'default'`, `locked` — is **`deployment-substrate`** (ADR 9 D3;
ADR 1 Am1 §3 §6 "Operator `config.features`"): tenant-visible, no owner, `manage` is
admin-grade, deploy-time write. It is **not** session or issue vocabulary and does **not** enter
the 1.4 field schemas. `source: 'user'` is a *resolution provenance* marker, not attribution —
it says which layer won, not which person. When per-user preference keys move to the per-user
family (§7.1), `source: 'user'` will resolve against the *reader's* row; that is POD-1076's
concern, not a new field here.

---

## 10. Existence-leak list — handed to Phase 3 (POD-290)

`docs/multi-user-readiness.md` §3.1.2 and ADR 9 §3 **O1** leave "which existence facts leak"
deliberately open, **per surface**. This list does **not** decide the policy. It records where
the surfaces are, so O1 arrives against a concrete inventory.

A field is listed when it reveals that **something exists** independently of its content.

| # | Surface | Field / mechanism | What it reveals |
|---|---|---|---|
| L-1 | Issue rollups | `childCount`, `childDoneCount`, `commentCount`, `sessionSummary.total`, `sessionSummary.byPhase` | That children / comments / sessions exist, and how many, without any of them being visible. **D7.4 candidates — a per-principal count is a materialized entity, not a join** |
| L-2 | Issue counts API | `IssueCount` (`byStage`/`byPriority`/`byType`/`byAssignee`), `IssueStats` (`total`/`open`/`closed`/`ready`/`blocked`/`deferred`) | Whole-tracker cardinality, including a **per-assignee histogram** — the strongest existence surface in the tracker |
| L-3 | Machine session lists | `HostSessionView` scans, `RpcSessionView`, `LakeReadSession`, daemon inventory | That sessions exist on a machine you may `see` but not `use` |
| L-4 | Worktree occupancy | `HandoffImportRequestMessage.occupiedWorktreePaths`, `IssueWorkspace.worktreePath`, `GitProbeTarget` | "This worktree is in use" — by whom is inferable from the path |
| L-5 | Lock holders | `locks`, `lock_waiters` (`LockWaiterRow`) | Substrate by design (everyone must resolve a lock name identically), but the **holder's identity** is a separate question — ADR 1 Am1 §7 marks it and routes to O1 |
| L-6 | Issue ref-letter allocation | `issue_ref_letters`, `refLetter`, `repo_draft_seq`, `refDraft`, `seq` | Monotonic allocation leaks *how many* sessions/issues exist in a repo, even with none visible |
| L-7 | Cross-boundary graph edges | `parentId`, `deps`, `dependents`, `blocksDeps`, `supersededBy`, `duplicateOf`, `discovered-from` edges | An edge naming an issue you cannot see. **This is O2's site**; the opaque-reference option leaks existence by construction |
| L-8 | Session ↔ issue back-references | `SessionMeta.issueId`, `IssueWire.sessions`/`sessionIds`, `coordinatorSessionId`, `startedBySession`, `deletedByIssueId` | That a session/issue on the other side of a visibility boundary exists |
| L-9 | Attribution ids | `humanQuestionAskedBy`, `spawnedBy`, `assignee` | That a session or person exists. **The member directory is the contested cell in ADR 1 Am1 §3 §11** |
| L-10 | Queue / mail counts | `queuedMessageCount`, `unackedMessages`, `IssueMessageRow` status counts | That undelivered work exists for a session you cannot read |
| L-11 | Mail send path | `mailSend` is deliberately **not** scope-gated (ADR 9 D7) | An error oracle: **mailing an invisible issue must fail *identically* to mailing a nonexistent id** (readiness §3.1.5). Already fixed in principle; listed because it is the one site with a decided rule |
| L-12 | Blob dedup | content-addressed blobs shared across owners | ADR 1 Am1 §4 marks this and routes to O1 |
| L-13 | Conversation registry | `ConversationIndexRow.machineId`, `parentConversationId`, `messageCount` | That a conversation (and its subagent tree) exists on a machine |

**Consistent-error rule to carry forward** (already decided for L-11, undecided elsewhere):
where existence is private, "invisible" and "nonexistent" must produce the **same** error.
Divergent errors turn any read path into an existence oracle.

---

## 11. State of the base, and of the verification lanes

This document was written on **`0e583f44`**, which was the tip of `issue/279-integration` when
POD-364 started. The integration branch has since advanced to **`201dd989`**. This diff is a
single new file, so it merges cleanly either way; the inventory itself was counted at `0e583f44`
and every line/key count above refers to that commit.

Lane results, each verified in a **detached worktree of the exact commit** (`git stash` is
repo-wide and forbidden), so a pre-existing failure cannot read as this issue's regression:

| Lane | at `0e583f44` (this document's base) | at `201dd989` (integration tip) | Attribution |
|---|---|---|---|
| `bun scripts/check-no-nul-bytes.ts` | **exit 1** — `BINARY: packages/client-core/src/engine/engine.ts`, two literal `0x00` | **exit 0** | Fixed by **`3d31eee7`** (POD-758), not by this issue. POD-1104 was filed for it and then closed as already-fixed |
| `bun scripts/rearch-audit.ts` | **exit 1** — ratchet counts went DOWN (`web-storage-keys` 13 → 12) against a stale baseline | **exit 0** — "deletion audit OK — 21 items, 264 sites remaining (baseline exact)" | Fixed by **`bf88f839`** (POD-861). A docs-only diff cannot move `web-storage-keys` |
| `bun run typecheck` | **green** (20/20 tasks, FULL TURBO) | — | Unaffected: no TS changed |
| `bun scripts/check-boundaries.ts` | **exit 1, pre-existing** — 71 violation lines (86 output lines), **byte-identical at base and at this HEAD** (`diff` clean). One hard `[agent-bridge-consumers]` failure in `apps/server/src/modules/sessions/service.ts` plus a block of unallowlisted `[harness-branching]` hits; POD-1105 owns the fix | — | Not this issue's: **before = after**, and no import was added |
| `bun run test` | **exit 1, 2 failures of 5282 tests** — `scripts/rearch-audit.test.ts` "exits 0 when the tree matches the committed baseline" and `scripts/architecture-manifest.test.ts` "tags every app and package that exists on disk". **Both reproduce on a clean detached worktree of `0e583f44` with the same two assertions** (2 failed / 143 passed when run in isolation there) | both green at the tip after `bf88f839` (POD-861) | Base staleness from the branch's rebase onto main. **The ratchet was deliberately NOT rebaselined** — a detector that stops matching is not a deletion. A Bun v1.3.14 segfault also fired during the full run; unrelated to the assertions |
| `bun run lint` | dies early at biome (known) | — | Per the fan-out protocol, `check-boundaries` is run directly instead |

**Nothing in this issue's diff can affect any lane**: it adds one Markdown file and modifies no
source, no schema, no migration, and no test.

## 12. Scope boundary — what this inventory deliberately does NOT cover

| Out of scope | Owner | Why it is named here anyway |
|---|---|---|
| Machines and every per-machine fact — `machines`, `repos`, `repo_prefixes`, worktrees, harness + model inventory, host metrics | **POD-1079** | Session and issue shapes **embed** these (`machineId`, `cwd`, `worktreePath`, `branch`, `repoId`). Per ADR 9 D3 rule 3 they are flagged **`inherited`** in §5, never classified independently |
| Superagent state — `superagent_threads`, `superagent_messages`, `superagent_queued_inputs`, `superagent_pending_turns` | ADR 9 D8 S2 (owner: the superagent's human) | Not 1.4 vocabulary. `ConciergeSessionInfo`/`BtwSessionInfo`/`FocusSessionInfo` **are** in scope because they are session ports |
| Messages / tracker mail, workflows, approvals, conversations, automations, locks, accounts, specs | POD-304 matrix rows; later phases | ~63 of the 194 scanned declarations. Their *attribution* sites are listed in §9 for completeness because §9 is the cheapest place to see them all at once |
| Entity-id branding sweep | **POD-360** | **D-14** records the gap in the meaning map; the sweep is not done here |
| Moving any schema into `packages/model` | **POD-299 / POD-300 / POD-365** | This issue is characterization only. **No source file was modified** — POD-299 is concurrently moving `packages/domain`, and an edit here would be a merge conflict for no gain |

---

## 13. LEDGER-ENTRY (for `docs/rearchitecture-v3.md` §8, Phase 1)

> **POD-364 (1.4a) — field-schema inventory, counted at `0e583f44`.** The epic's "roughly eight
> definitions of a session" is wrong by ~3×: **28 named session representations** and **17 issue
> representations** exist, enumerated mechanically from `git ls-files` (1576 TS files, NUL-stripped
> before parsing — the guardrail `check-no-nul-bytes` was RED on the counting base for
> `packages/client-core/src/engine/engine.ts`, a file a grep sweep cannot see at all; fixed
> independently at `3d31eee7` while this was written). 6 session and 3
> issue representations are **drifted duplicates** with named deletions; the rest are legitimate
> R1–R6 roles, and **no R1 exists today** — truth is split across `sessions` (48 cols),
> `SessionDurableState` (44 live fields, 5 with no column at all) and `SessionMeta` (55 keys).
> 16 disagreement classes (**D-1…D-16**) are catalogued, including four `IssueWire.sessions`-shaped
> embed sites rather than one, four encodings of `resume`, three spellings of one clock, and the
> spawn tuple restated in four places. The composition plan names 14 session and 13 issue shared
> field schemas plus four cross-entity schemas (`Ownership`, `GrantEdge`, `Attribution`,
> `PerUserKey`) placed **once**, agreed with POD-1075 on four assertions. 11 per-user-state
> candidates are marked for POD-1076 with three open questions recorded not answered; the reserved
> `op-stream` set (composer draft, issue `description`/`notes`) is marked reserved-not-built with
> ADR 2 D5's materialized-value-plus-bounded-tail constraint attached; 12 attribution sites are
> mapped half-by-half with the automation-creator gap recorded; and a 13-item **existence-leak
> list (L-1…L-13)** is handed to Phase 3 (POD-290) against ADR 9 §3 O1/O2.
> Document: `docs/rearch-field-schema-inventory.md`. Reviewed against ADR 4 + Amendment 1 and
> ADR 9 D3/D4 (§14).

---

## 14. Review against the representation policy and ADR 9 D3/D4

| Requirement | Where satisfied |
|---|---|
| ADR 4 D1 — one vocabulary, **not** one universal record | §6: 14 + 13 field schemas, six distinct roles preserved, R5 ports retained |
| ADR 4 D2 — every representation declares exactly one role | §2, §3: role column filled for all 45 |
| ADR 4 D3.1/D3.2 — field groups; compose, never copy key lists | §6.2/§6.3 define the groups; §6.4 states each `Pick` |
| ADR 4 D3.3 — propagate or fail compilation | §6.5 rule 1 (no anonymous projections) is what makes this checkable |
| ADR 4 D3.4 — one store↔wire mapping pair per entity | §6.5 rule 2 |
| ADR 4 D3.5 — branded ids | **D-14**; sweep is POD-360's |
| ADR 4 D3.6 — server-derived fields are pure functions | `SessionDerived`, `IssueDerived`; **D-5** lists today's stored/derived twins |
| ADR 4 D3.7 — live-only fields are not R1 members | `SessionLiveOverlay`; **D-9** names the five column-less wire fields |
| ADR 4 D3.8 — provenance on the envelope | **D-13**; `viaHub`/`upstreamStale`/`pendingSync` leave the entities |
| ADR 4 D3.9 — optimistic UI is not a representation role | `optimisticIssuePatch` (`packages/sync/src/upstream-forwarder.ts:82`) is **characterized, not deleted** — POD-367's scope. Note it reads `askedBy` from *input* for the node-side overlay only; hub truth overwrites, and the server path stays authoritative |
| ADR 4 D4 — `HandoffManifest` is R6; frames stay protocol | §2 row 8, §6.4 last rows |
| ADR 4 D6 — drizzle is R3 authoring, not the vocabulary | §2 row 1, §3 row 1; encoding splits live in the mapper |
| ADR 4 D7.1 — no entity-in-entity on the wire | **D-4**: four embed sites named, one of which rides the feed |
| ADR 4 D7.2 — no O(entities) work on write/publish/fan-out | Consequence of D-4's removal; gated by POD-736's harness |
| ADR 4 D7.3/D8 — cross-entity read models are replica-side over the **slice** | `IssueDerived` rollups flagged as **D7.4 materialized-entity candidates** precisely because a scoped client may not hold their inputs |
| ADR 4 Am1 D9 — owner/visibility/grant as shared schemas; attribution a **pair** | §6.1 (placed once), §9 (pair, half by half) |
| ADR 4 Am1 D10 — per-user state is a keyed shape, not a field | §7, `PerUserKey` |
| ADR 9 D3 — five visibility classes, machine facts inherit | Visibility column in §2/§3/§5; `inherited` used for every machine fact; `FeatureState` placed as substrate (§9.2) |
| ADR 9 D4 — **default-closed**; unclassifiable ⇒ personal/private | No cell in §2/§3/§5 is blank. Everything not demonstrably substrate, secret, per-user or machine-inherited is recorded **`personal`** |
| ADR 9 D5 A3 — both halves stamped from the transport principal | §9; the `askedBy` server-authoritative check is the one site already close to compliant |
| ADR 1 Am1 D10 — per-user family; `archived`/`workState` shared | §7.1, §7.2 (recorded, not reopened) |
| ADR 1 Am1 D12 — `op-stream` reserved, not built | §8, with the ADR 2 D5 constraint attached |
