import { companion, lazy } from '@podium/mobx-helpers'
import type { IssueAllowedActions, IssueSessionSummaryEntry } from '@podium/model'
import { action, compareShallow, reaction } from 'mobx'
import type { PageIssue } from './issue-page'
import type { MobxPool } from './pool'
import { RequestAnswer } from './request-answer'

/** One collaborator as `issues.collaborators` answers (POD-6290). */
export interface IssueCollaboratorWire {
  userId: string
  joinedAt: string
  via: string | null
}

/** The two server reads behind the shared half of a task page. */
export interface IssueSharedDetailPorts {
  /** `issues.get`: the reader's allowed actions and the D13 session summaries. */
  get(id: string): Promise<{
    allowed?: IssueAllowedActions
    sessionSummaries?: IssueSessionSummaryEntry[]
  } | null>
  /** `issues.collaborators`: the members who started or joined the task. */
  collaborators(id: string): Promise<IssueCollaboratorWire[]>
}

interface SharedAnswer {
  allowed: IssueAllowedActions | undefined
  sessionSummaries: readonly IssueSessionSummaryEntry[]
  collaborators: readonly IssueCollaboratorWire[]
}

/**
 * THE SHARED HALF OF A TASK PAGE (POD-6295; design §2.2, §2.3).
 *
 * Three answers no feed row carries, read from the server for the open task:
 * - `allowed`: what this reader may do (reassign, edit, restore, comment). The
 *   page draws those controls from it and never re-derives policy;
 * - `sessionSummaries`: every agent session on the task as owner, title and
 *   live or idle (D13). Other members' sessions reach this client only so;
 * - `collaborators`: the members with a start or join record.
 *
 * One store per task, shared by every section that shows part of it (rail,
 * body, composer), held while any of them is open (rule 9) and re-read when
 * the task changes. Other members' sessions change state without touching the
 * task, so the page also asks for `refresh()` on a visible timer.
 */
export class IssueSharedDetail extends RequestAnswer<SharedAnswer> {
  private users = 0
  private stop: (() => void) | undefined
  private ports: IssueSharedDetailPorts | undefined

  constructor(
    readonly issue: PageIssue,
    private readonly live: Set<IssueSharedDetail>,
  ) {
    super()
  }

  /** Hold the store while a section shows it; the returned call lets go. */
  retain(ports: IssueSharedDetailPorts): () => void {
    if (this.users++ === 0) {
      this.live.add(this)
      this.ports = ports
      this.stop = reaction(
        () => this.issue.updatedAt,
        () => this.refresh(),
        { fireImmediately: true },
      )
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.users === 0) this.release()
    }
  }

  /** Read the three answers again (a no-op while nothing holds the store). */
  @action refresh(): void {
    const ports = this.ports
    if (!ports) return
    const id = this.issue.id
    void this.load(async () => {
      const [read, collaborators] = await Promise.all([
        ports.get(id),
        // An older server has no collaborators read: none known.
        ports.collaborators(id).catch((): IssueCollaboratorWire[] => []),
      ])
      return {
        allowed: read?.allowed,
        sessionSummaries: read?.sessionSummaries ?? [],
        collaborators: Array.isArray(collaborators) ? collaborators : [],
      }
    })
  }

  /** What the reader may do; undefined until the server has said. */
  @lazy get allowed(): IssueAllowedActions | undefined {
    return this.answer?.allowed
  }

  /** Every agent session on the task, as D13 lets any reader see it. */
  @lazy({ equals: compareShallow }) get sessionSummaries(): readonly IssueSessionSummaryEntry[] {
    return this.answer?.sessionSummaries ?? []
  }

  /** The collaborators' member ids, earliest first. */
  @lazy({ equals: compareShallow }) get collaboratorIds(): string[] {
    return (this.answer?.collaborators ?? []).map((c) => c.userId)
  }

  private release(): void {
    this.stop?.()
    this.stop = undefined
    this.ports = undefined
    this.live.delete(this)
    this.close()
  }

  dispose(): void {
    if (this.users === 0) return
    this.users = 0
    this.release()
  }
}

/** The pool's one shared-detail store for task `id`. */
export function issueSharedDetail(pool: MobxPool, id: string): IssueSharedDetail {
  const owner = pool.sources.view('issue-shared-detail', () => {
    const live = new Set<IssueSharedDetail>()
    const row = companion((issue: PageIssue) => new IssueSharedDetail(issue, live))
    return {
      row,
      dispose() {
        for (const detail of [...live]) detail.dispose()
        live.clear()
      },
    }
  })
  return owner.row(pool.issueObject(id) as PageIssue)
}

/**
 * The D13 summaries to show beside the reader's own session rows: sessions
 * that belong to another member. The reader's own sessions are already rows
 * they can open; a summary repeating one would be a second, dead copy.
 */
export function otherMembersSessions(
  summaries: readonly IssueSessionSummaryEntry[],
  viewer: string | undefined,
): IssueSessionSummaryEntry[] {
  if (!viewer) return []
  return summaries.filter((s) => s.owner !== viewer)
}
