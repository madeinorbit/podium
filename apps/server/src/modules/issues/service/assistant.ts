import type { IssueWire, SessionId } from '@podium/model'
import { sessionsForIssue } from '../../../issue-util'
import { buildAssistantMessages, parseAssistantJson } from '../../../issueAssistant'
import { completeForRole } from '../../../llm-roles'
import type { IssueStore } from './core'

/**
 * THE ISSUE ACTIVITY DIGEST — the second job the git-workflow capability was doing.
 *
 * `IssueGitWorkflowModule` owns the git side of an issue: branch/worktree lifecycle,
 * PR/merge actions, epic integration, and the per-session git projection its debounce
 * coalesces. This module owns something else entirely — asking an LLM what has been
 * happening on an issue and writing its prose onto the row (`activityNotes`,
 * `blockedBy`, `dependencyNote`, and the stage SUGGESTION the user can apply or
 * dismiss).
 *
 * The seam is real rather than cosmetic, and POD-1606 cut here for that reason. The
 * cohesive-owner argument POD-1385 accepted for `workflow.ts` says its fields "are one
 * debounce mechanism over one subject" — `gitRefreshes` holding the in-flight refresh
 * per repo, `gitCommitsBySession`/`gitTouchedBySession` the accumulations it publishes.
 * `assistantTimers` was never part of that mechanism: it debounces an LLM call, not a
 * git probe, and nothing here reads or writes any of the three git maps. Two debounces
 * over two subjects were sharing one owner because both happened to be triggered by
 * session activity, which is a trigger they have in common, not state.
 *
 * It reaches the workflow module not at all: the only port is {@link IssueStore}, the
 * single store POD-320's capabilities already compose over. `workflow.ts` keeps
 * one-line delegates so the registry, the session-wiring ports and every existing test
 * call the same method names on the same object.
 */
export class IssueAssistantDigestModule {
  /** Per-issue debounce for the digest. Not git state: it holds one pending LLM
   *  call per issue, coalescing a burst of session activity into a single refresh. */
  private assistantTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly store: IssueStore) {}

  /** A member session did something. Debounce a digest refresh for the issue that
   *  owns its worktree — 120s after the LAST activity, not once per event. */
  onSessionActivity(sessionId: SessionId): void {
    if (!this.store.d.getSettings().issues?.assistantEnabled) return
    const sess = this.store.d.listSessions().find((s) => s.sessionId === sessionId)
    if (!sess) return
    const row = [...this.store.rows.values()].find(
      (r) =>
        r.worktreePath &&
        (sess.cwd === r.worktreePath || sess.cwd.startsWith(`${r.worktreePath}/`)),
    )
    if (!row) return
    const prev = this.assistantTimers.get(row.id)
    if (prev) clearTimeout(prev)
    this.assistantTimers.set(
      row.id,
      setTimeout(() => {
        this.assistantTimers.delete(row.id)
        void this.refreshAssistant(row.id).catch(() => {})
      }, 120_000),
    )
  }

  async refreshAssistant(id: string): Promise<IssueWire> {
    const row = this.store.rowOrThrow(id)
    if (!row.worktreePath) return this.store.toWire(row)
    const settings = this.store.d.getSettings()
    const members = sessionsForIssue(row.worktreePath, this.store.d.listSessions(), row.id).map(
      (s) => ({
        agentKind: s.agentKind,
        phase: s.agentState?.phase ?? 'shell',
        tail: '',
      }),
    )
    const [status, log] = await Promise.all([
      this.store.d.repoOp('status', row.worktreePath).catch(() => ({ ok: false, output: '' })),
      this.store.d.repoOp('log', row.worktreePath).catch(() => ({ ok: false, output: '' })),
    ])
    const others = [...this.store.rows.values()]
      .filter(
        (r) =>
          r.id !== row.id && this.store.inRepoScope(r, row.repoPath) && !r.archived && !r.deletedAt,
      )
      .map((r) => ({ seq: r.seq, title: r.title, stage: r.stage, branch: r.branch }))
    const ctx = {
      issue: {
        title: row.title,
        description: row.description,
        stage: row.stage,
        branch: row.branch,
        ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      },
      gitStatus: status.output,
      gitLog: log.output,
      members,
      otherIssues: others,
    }
    let result = null as ReturnType<typeof parseAssistantJson>
    try {
      // The shared one-shot primitive (SP-6454): resolves the 'background' role's
      // backend + account, runs one completion, parses into structured data.
      const resp = await completeForRole(
        {
          settings,
          // POD-419: the provider's key, resolved at the moment of use out of
          // the server-only store — `settings.apiKeys` no longer carries any.
          apiKey: (provider) => this.store.d.store.secrets.apiKeyFor(provider),
          llm: this.store.d.llm,
        },
        { role: 'background', messages: buildAssistantMessages(ctx), parse: parseAssistantJson },
      )
      result = resp.data
    } catch {
      result = null
    }
    if (!result) return this.store.toWire(row) // leave prior state intact on any LLM/parse failure
    row.activityNotes = result.activityNotes || row.activityNotes
    row.notesUpdatedAt = this.store.now()
    row.blockedBy = result.blockedBy
    row.dependencyNote = result.dependencyNote || null
    // Trust the model's stage when valid and different from current; else clear the suggestion.
    const digestStage = result.suggestedStage
    row.suggestedStage = digestStage && digestStage !== row.stage ? digestStage : null
    row.suggestedReason = row.suggestedStage ? result.suggestedReason : null
    return this.store.persistRow(row)
  }
}
