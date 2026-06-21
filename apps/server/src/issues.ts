import { randomUUID } from 'node:crypto'
import type { PodiumSettings } from '@podium/core'
import { type IssueWire, type RepoOp, type ServerMessage, type SessionMeta } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from './issue-util'
import type { IssueRow, SessionStore } from './store'
import { llmClient } from './llm'

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
