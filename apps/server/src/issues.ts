import { randomUUID } from 'node:crypto'
import type { PodiumSettings } from '@podium/core'
import { type IssueWire, type RepoOp, type ServerMessage, type SessionMeta } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from './issue-util'
import type { IssueRow, SessionStore } from './store'
import { buildAssistantMessages, parseAssistantJson } from './issueAssistant'
import { llmClient } from './llm'
import { type LinearIssue, searchIssues } from './linear'

export interface IssueDeps {
  store: SessionStore
  listSessions(): SessionMeta[]
  getSettings(): PodiumSettings
  spawnSession(o: { cwd: string; agentKind?: string }): { sessionId: string }
  seedDraft(sessionId: string, text: string): void
  repoOp(op: RepoOp, cwd: string, args?: Record<string, string>): Promise<{ ok: boolean; output: string }>
  broadcast(msg: ServerMessage): void
  now?(): string
  defaultRepoBranch?(repoPath: string): Promise<string>
  llm?: typeof llmClient
  linearSearch?(key: string, q: string): Promise<LinearIssue[]>
}

export interface CreateIssueInput {
  repoPath: string
  title: string
  description?: string
  parentBranch?: string
  defaultAgent?: string
  startNow: boolean
  linear?: { id?: string; identifier: string; url: string }
}

export class IssueService {
  private readonly rows = new Map<string, IssueRow>()
  constructor(private readonly deps: IssueDeps) {
    for (const r of deps.store.listIssueRows()) this.rows.set(r.id, r)
  }
  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  toWire(row: IssueRow): IssueWire {
    const sessions = sessionsForIssue(row.worktreePath, this.deps.listSessions())
    return {
      id: row.id, repoPath: row.repoPath, seq: row.seq, title: row.title, description: row.description,
      stage: row.stage as IssueWire['stage'], worktreePath: row.worktreePath, branch: row.branch,
      parentBranch: row.parentBranch, defaultAgent: row.defaultAgent,
      ...(row.linearId ? { linearId: row.linearId } : {}),
      ...(row.linearIdentifier ? { linearIdentifier: row.linearIdentifier } : {}),
      ...(row.linearUrl ? { linearUrl: row.linearUrl } : {}),
      ...(row.activityNotes ? { activityNotes: row.activityNotes } : {}),
      ...(row.notesUpdatedAt ? { notesUpdatedAt: row.notesUpdatedAt } : {}),
      ...(row.suggestedStage ? { suggestedStage: row.suggestedStage as IssueWire['stage'] } : {}),
      ...(row.suggestedReason ? { suggestedReason: row.suggestedReason } : {}),
      blockedBy: row.blockedBy,
      ...(row.dependencyNote ? { dependencyNote: row.dependencyNote } : {}),
      ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      createdAt: row.createdAt, updatedAt: row.updatedAt, archived: row.archived,
      sessions, sessionSummary: summarizeSessions(sessions),
    }
  }

  list(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .sort((a, b) => (a.repoPath === b.repoPath ? a.seq - b.seq : a.repoPath.localeCompare(b.repoPath)))
      .map((r) => this.toWire(r))
  }
  get(id: string): IssueWire | null {
    const r = this.rows.get(id)
    return r ? this.toWire(r) : null
  }
  allWire(): IssueWire[] {
    return this.list()
  }

  private persist(row: IssueRow): IssueWire {
    row.updatedAt = this.now()
    this.rows.set(row.id, row)
    this.deps.store.upsertIssue(row)
    const wire = this.toWire(row)
    this.deps.broadcast({ type: 'issueUpdated', issue: wire })
    this.deps.broadcast({ type: 'issuesChanged', issues: this.allWire() })
    return wire
  }

  create(input: CreateIssueInput): IssueWire {
    const seq = this.deps.store.nextIssueSeq(input.repoPath)
    const ts = this.now()
    const row: IssueRow = {
      id: `iss_${randomUUID()}`, repoPath: input.repoPath, seq, title: input.title,
      description: input.description ?? '', stage: 'backlog', worktreePath: null, branch: null,
      parentBranch: input.parentBranch || this.deps.getSettings().gitWorkflow.defaultParentBranch || 'main',
      defaultAgent: input.defaultAgent || this.deps.getSettings().sessionDefaults.agent || 'claude-code',
      linearId: input.linear?.id ?? null, linearIdentifier: input.linear?.identifier ?? null,
      linearUrl: input.linear?.url ?? null, activityNotes: null, notesUpdatedAt: null,
      suggestedStage: null, suggestedReason: null, blockedBy: [], dependencyNote: null, prUrl: null,
      createdAt: ts, updatedAt: ts, archived: false,
    }
    const wire = this.persist(row)
    return wire
  }

  update(id: string, patch: Partial<Pick<IssueRow, 'title' | 'description' | 'stage' | 'worktreePath' | 'branch' | 'parentBranch' | 'defaultAgent' | 'archived'>>): IssueWire {
    const row = this.rows.get(id)
    if (!row) throw new Error(`unknown issue ${id}`)
    Object.assign(row, patch)
    return this.persist(row)
  }

  archive(id: string): IssueWire {
    return this.update(id, { archived: true })
  }

  private worktreePathFor(repoPath: string, branch: string): string {
    // branch is `issue/<seq>-<slug>`; flatten to a directory name under <repo>/.worktrees
    const dir = branch.replace(/\//g, '-')
    return `${repoPath}/.worktrees/${dir}`
  }

  async start(id: string): Promise<IssueWire> {
    const row = this.rowOrThrow(id)
    if (row.worktreePath) return this.toWire(row) // already started
    const branch = this.slug(row.seq, row.title)
    const path = this.worktreePathFor(row.repoPath, branch)
    const res = await this.d.repoOp('worktreeAdd', row.repoPath, { path, branch, startPoint: row.parentBranch })
    if (!res.ok) throw new Error(`worktree add failed: ${res.output}`)
    row.branch = branch
    row.worktreePath = path
    row.stage = 'planning'
    const wire = this.persistRow(row)
    const { sessionId } = this.d.spawnSession({ cwd: path, agentKind: row.defaultAgent })
    if (row.description.trim()) this.d.seedDraft(sessionId, row.description)
    return wire
  }

  async createAndMaybeStart(input: CreateIssueInput): Promise<IssueWire> {
    const created = this.create(input)
    return input.startNow ? this.start(created.id) : created
  }

  async action(id: string, kind: 'rebase' | 'pr' | 'merge'): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath || !row.branch) throw new Error('issue not started')
    const gw = this.d.getSettings().gitWorkflow
    if (kind === 'rebase') {
      const r = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
      return { ...r, issue: this.toWire(row) }
    }
    if (kind === 'pr') {
      const r = await this.d.repoOp('prCreate', row.worktreePath, { branch: row.branch, parentBranch: row.parentBranch })
      if (r.ok) {
        const url = r.output.match(/https?:\/\/\S+/)?.[0]
        if (url) row.prUrl = url
      }
      return { ...r, issue: this.persistRow(row) }
    }
    // merge
    if (gw.autoRebaseBeforeMerge) {
      const rb = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
      if (!rb.ok) return { ...rb, issue: this.toWire(row) }
    }
    // mergeFfOnly runs on the repo root (parent-branch checkout), NOT the worktree
    const r = await this.d.repoOp('mergeFfOnly', row.repoPath, { branch: row.branch })
    return { ...r, issue: this.toWire(row) }
  }

  addSession(id: string, agentKind?: string): IssueWire {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath) throw new Error('issue not started')
    this.d.spawnSession({ cwd: row.worktreePath, agentKind: agentKind ?? row.defaultAgent })
    return this.toWire(row)
  }
  addShell(id: string): IssueWire {
    return this.addSession(id, 'shell')
  }

  async linearSearch(query: string): Promise<LinearIssue[]> {
    const key = this.d.getSettings().integrations?.linearApiKey
    if (!key) return []
    const search = this.d.linearSearch ?? searchIssues
    return search(key, query)
  }

  private assistantTimers = new Map<string, ReturnType<typeof setTimeout>>()

  applySuggestion(id: string): IssueWire {
    const row = this.rowOrThrow(id)
    if (row.suggestedStage) row.stage = row.suggestedStage
    row.suggestedStage = null
    row.suggestedReason = null
    return this.persistRow(row)
  }
  dismissSuggestion(id: string): IssueWire {
    const row = this.rowOrThrow(id)
    row.suggestedStage = null
    row.suggestedReason = null
    return this.persistRow(row)
  }

  onSessionActivity(sessionId: string): void {
    if (!this.d.getSettings().issues?.assistantEnabled) return
    const sess = this.d.listSessions().find((s) => s.sessionId === sessionId)
    if (!sess) return
    const row = [...this.rows.values()].find(
      (r) => r.worktreePath && (sess.cwd === r.worktreePath || sess.cwd.startsWith(`${r.worktreePath}/`)),
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
    const row = this.rowOrThrow(id)
    if (!row.worktreePath) return this.toWire(row)
    const settings = this.d.getSettings()
    const members = sessionsForIssue(row.worktreePath, this.d.listSessions()).map((s) => ({
      agentKind: s.agentKind,
      phase: s.agentState?.phase ?? 'shell',
      tail: '',
    }))
    const [status, log] = await Promise.all([
      this.d.repoOp('status', row.worktreePath).catch(() => ({ ok: false, output: '' })),
      this.d.repoOp('log', row.worktreePath).catch(() => ({ ok: false, output: '' })),
    ])
    const others = [...this.rows.values()]
      .filter((r) => r.id !== row.id && r.repoPath === row.repoPath && !r.archived)
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
      const factory = this.d.llm ?? llmClient
      const client = factory(settings.workLlm, settings.apiKeys)
      const resp = await client.complete(buildAssistantMessages(ctx), [])
      result = parseAssistantJson(resp.text)
    } catch {
      result = null
    }
    if (!result) return this.toWire(row) // leave prior state intact on any LLM/parse failure
    row.activityNotes = result.activityNotes || row.activityNotes
    row.notesUpdatedAt = this.now()
    row.blockedBy = result.blockedBy
    row.dependencyNote = result.dependencyNote || null
    // Trust the model's stage when valid and different from current; else clear the suggestion.
    const digestStage = result.suggestedStage
    row.suggestedStage = digestStage && digestStage !== row.stage ? digestStage : null
    row.suggestedReason = row.suggestedStage ? result.suggestedReason : null
    return this.persistRow(row)
  }

  // The following are implemented in later tasks (declared here so the class is complete):
  // start(id), action(id, kind), linearSearch(query), applySuggestion(id),
  // dismissSuggestion(id), refreshAssistant(id), addSession/addShell, onSessionActivity.
  /** @internal exposed for later tasks */
  protected rowOrThrow(id: string): IssueRow {
    const r = this.rows.get(id)
    if (!r) throw new Error(`unknown issue ${id}`)
    return r
  }
  /** @internal */
  protected persistRow(row: IssueRow): IssueWire {
    return this.persist(row)
  }
  /** @internal */
  protected get d(): IssueDeps {
    return this.deps
  }
  protected slug = slugifyBranch
}
