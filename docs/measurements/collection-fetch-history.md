# Collection fetch on ten times the history (POD-7085)

The browser's first download without its last step (the issue stubs, which
cover all history by design), answered by the sync worker's producer on the
startup corpus (`buildCorpusCell`, POD-4747, seed 4443) at history x1 (`h1a1`)
and x10 (`h10a1`): the same active work under ten times the closed, archived
and deleted history. Test: `apps/server/src/sync/first-download.history.test.ts`.
Measured on the vega agents VM, 2026-11-17, at `0775f41dea` (SQLite; Postgres is
out of scope for this phase).

## Records and statements

| | History x1 | History x10 |
| --- | ---: | ---: |
| Issues (whole) | 3,662 | 3,662 |
| Dependencies | 2,640 | 2,640 |
| Repositories | 485 | 485 |
| Sessions | 1,803 | **4,932** |
| Statements, policy set without stubs | 263 | **318** |
| Issue stubs step: stubs | 4,867 | 27,601 |
| Issue stubs step: statements | 52 | 282 |

Every issue count is equal at both sizes: the sidebar, recent and what issues
come with read no history. The sessions are not. Corpus history sessions are
never archived, and "sessions with no issue" (`session.noIssue`: not archived,
no issue, the sidebar's lanes) has no age bound, so it holds every old
issueless session. That collection is the likely source of the extra 3,129
sessions; the measurement does not split the count by collection. The
statement growth follows from it: the extra sessions are built in more pages
of 500. The stubs step grows with history by design (one page of 500 per read).

## Query plans at history x10

Every statement of the policy set and of what it comes with seeks an index,
except "asking":

| Statement | Plan |
| --- | --- |
| `session.live` | `idx_sessions_status (status=?)` |
| `session.asking` | **SCAN sessions**, each row's offer, runtime turn state and checkpoint by primary key |
| `issueProjection.recent` | `idx_issues_stage_updated (ANY(stage) AND updated_at>?)` |
| `session.recent` | `idx_sessions_published_active (published_last_active_at>?)` |
| `workflowRun.recent` | `workflow_runs_started (started_at>?)` |
| `automationRun.recent` | `idx_automation_runs_fired (fired_at>?)` |
| `conversation.recent` | `idx_conversations_created_at (<expr>>?)` |
| `issueProjection.sidebar` | `idx_issues_stage_updated (stage=?)` per open stage |
| sidebar comes with `session.ofIssue` | `idx_sessions_issue_archived (issue_id=? AND archived=?)` |
| a session comes with its issue | issues primary key |
| a session comes with its state | `idx_session_user_state_session`, `idx_snoozes_session` (UNION ALL) |
| an issue comes with its parent, state, git state, dependencies | primary keys, `idx_issue_user_state_issue` |
| an ask, a pin comes with its target | primary keys |
| an issue's ancestors | one recursive walk on the issues primary key |

The indexes `idx_issues_stage_updated`, `idx_issues_updated`,
`idx_sessions_published_active`, `idx_sessions_issue_archived`,
`idx_conversations_created_at` and `idx_automation_runs_fired` are added by the
migration `20261117214033_collection-fetch-indexes`; the conversations index is on
`coalesce(created_at, '')`, the expression the fetch reads the time as.

A history collection's later pages seek below their position on the time
index (the keyset condition leads with a bound on the time alone). Its first
page reads the whole collection in order, for the viewer's total; it is fetched
on demand, never in the first download, and listed as a whole-table read in the
query-plan audit.

## Open

- **Asking reads every session.** Its rule reads the agent state each record
  carries: the runtime turn state over the observation checkpoint over the
  row, and the offer unless a later input made it stale. No index serves an
  expression over three tables. Proposed fix: keep the derived "asks the user"
  state as one column on the session row, written where the agent state and
  the offer are written, and index it.
- **Sessions with no issue grew with history** (resolved 2026-11-17, coordinator
  decision A): the rule now holds only those live, asking or active in the policy's
  days, a subset of Live, Asking and Recent, so the policy holds no separate
  collection for it.
