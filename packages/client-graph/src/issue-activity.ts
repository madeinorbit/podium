import {
  HIDDEN_ISSUE_EVENT_KINDS,
  IssueActivityHistory,
  type ActivityComment,
  type IssueEvent,
} from '@podium/client-core/values'
import type { IssueId } from '@podium/model/browser'
import { action, observable, observableRef, reaction, runInAction } from 'mobx'
import type { PageIssue } from './issue-page'
import { companion, lazy } from '@podium/mobx-helpers'
import type { MobxPool } from './pool'

export interface IssueActivityMail {
  id: string
  issueId: IssueId
  fromAuthor: string
  body: string
  createdAt: string
  status: 'unread' | 'read' | 'claimed'
  claimedBy: string | null
  wasUnread: boolean
}
export interface IssueActivityPorts {
  comments(id: string): Promise<ActivityComment[]>
  mail(id: string): Promise<IssueActivityMail[]>
  events(input: {
    since: number
    repoPath: string
    subject: string
    limit: number
    excludeKinds: readonly string[]
    order?: 'desc'
    before?: number
  }): Promise<IssueEvent[]>
}

/** Events per request, both directions. */
export const ISSUE_HISTORY_PAGE = 50
/** What the side panel's Recent activity shows. */
export const RECENT_ACTIVITY_SIZE = 5

/** One issue's history, shared by every open view of it (full page, side
 * panel, phone). It holds a contiguous window of the event log, newest first:
 * a view asks for the event lines it shows (`ensure`) and the window pages back
 * only that far; new events arrive through the forward cursor. Comments and
 * mail update in place, keeping unchanged items. When the last view closes the
 * history is released (rule 9); the next opening starts from the newest page. */
export class IssueActivityStore {
  readonly history = new IssueActivityHistory()
  @observableRef accessor mail: IssueActivityMail[] = []
  @observable accessor revision = 0
  /** A window is loaded and the issue has older events below it. */
  @observable accessor earlier = false
  /** The oldest event of the issue is loaded: nothing earlier to page. */
  private complete = false
  private users = 0
  private stop: (() => void) | undefined
  private ports: IssueActivityPorts | undefined
  private epoch = 0
  private commentsEpoch = 0
  /** The newest page has landed; forward reads are safe from here on. */
  private started = false
  /** A server that ignores `order` answers ascending from `since`. */
  private ascendingOnly = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly issue: PageIssue,
    private readonly live: Set<IssueActivityStore>,
  ) {}
  private publish() {
    runInAction(() => {
      this.revision++
    })
  }
  appendComment = (body: string) => {
    this.history.appendComment({ author: 'me', body, createdAt: new Date().toISOString() })
    this.publish()
  }
  retain(ports: IssueActivityPorts): () => void {
    if (this.users++ === 0) {
      this.live.add(this)
      this.ports = ports
      const epoch = ++this.epoch
      this.stop = reaction(
        () => [this.issue.updatedAt, this.issue.repoPath] as const,
        () => this.refresh(epoch),
        { fireImmediately: true },
      )
    }
    const epoch = this.epoch
    let released = false
    return () => {
      // A release after dispose belongs to a holder dispose already let go.
      if (released || epoch !== this.epoch) return
      released = true
      if (--this.users === 0) this.release()
    }
  }
  /** Load back until at least `visible` event lines are held, or the issue's
   * first event is. Rejects when a page fails; what is loaded stays. */
  ensure(visible: number): Promise<void> {
    return this.enqueue(this.epoch, async (ports, epoch) => {
      while (epoch === this.epoch && !this.complete && this.history.visibleEvents < visible)
        await this.pageBack(ports, epoch)
    })
  }
  /** Reads run one at a time, so the two cursors never race; a read queued
   * before a release is dropped. */
  private enqueue(
    epoch: number,
    task: (ports: IssueActivityPorts, epoch: number) => Promise<void>,
  ): Promise<void> {
    const run = this.queue.then(() =>
      this.ports && epoch === this.epoch ? task(this.ports, epoch) : undefined,
    )
    this.queue = run.catch(() => {})
    return run
  }
  private async pageBack(ports: IssueActivityPorts, epoch: number) {
    if (this.ascendingOnly) return this.drainForward(ports, epoch, true)
    const floor = this.history.floor
    const rows = await ports.events({
      ...this.page(0),
      order: 'desc',
      ...(floor ? { before: floor } : {}),
    })
    if (epoch !== this.epoch) return
    const page = Array.isArray(rows) ? rows : []
    if (page.length > 1 && page[0]!.id < page[page.length - 1]!.id) {
      // An older server ignored `order` and read from the log's start: keep
      // its answer and finish the way it can, ascending to the end.
      this.ascendingOnly = true
      this.history.appendEvents(page)
      return this.drainForward(ports, epoch, true)
    }
    const added = this.history.appendEvents(page)
    this.started = true
    if (page.length < ISSUE_HISTORY_PAGE || added === 0) this.complete = true
    runInAction(() => {
      this.earlier = !this.complete
      this.revision++
    })
  }
  /** Read forward from the newest loaded event until the log runs out. */
  private async drainForward(ports: IssueActivityPorts, epoch: number, toStart = false) {
    for (;;) {
      const before = this.history.since
      const rows = await ports.events(this.page(before))
      if (epoch !== this.epoch) return
      if (!Array.isArray(rows)) break
      if (this.history.appendEvents(rows)) this.publish()
      if (rows.length < ISSUE_HISTORY_PAGE || this.history.since <= before) break
    }
    this.started = true
    if (toStart) {
      this.complete = true
      runInAction(() => {
        this.earlier = false
      })
    }
  }
  private page(since: number) {
    return {
      since,
      repoPath: this.issue.repoPath,
      subject: this.issue.id,
      limit: ISSUE_HISTORY_PAGE,
      excludeKinds: HIDDEN_ISSUE_EVENT_KINDS,
    }
  }
  private refresh(epoch: number) {
    const ports = this.ports
    if (!ports) return
    const request = ++this.commentsEpoch
    Promise.resolve()
      .then(() => ports.comments(this.issue.id))
      .then((rows) => {
        if (epoch !== this.epoch || request !== this.commentsEpoch) return
        if (this.history.replaceComments(Array.isArray(rows) ? rows : [])) this.publish()
      })
      .catch(() => {})
    Promise.resolve()
      .then(() => ports.mail(this.issue.id))
      .then((rows) => {
        if (epoch !== this.epoch || request !== this.commentsEpoch) return
        const next = mergeMail(this.mail, Array.isArray(rows) ? rows : [])
        if (next !== this.mail)
          runInAction(() => {
            this.mail = next
          })
      })
      .catch(() => {})
    // Before the newest page lands there is no forward cursor; that page
    // already carries anything new.
    void this.enqueue(epoch, (current) =>
      this.started ? this.drainForward(current, epoch) : Promise.resolve(),
    ).catch(() => {
      /* Preserve already loaded history; the next update reads forward again. */
    })
  }
  private release() {
    this.stop?.()
    this.stop = undefined
    this.ports = undefined
    this.epoch++
    this.commentsEpoch++
    this.started = false
    this.ascendingOnly = false
    this.complete = false
    this.live.delete(this)
    this.history.reset()
    runInAction(() => {
      this.mail = []
      this.earlier = false
      this.revision++
    })
  }
  dispose() {
    if (this.users === 0) return
    this.users = 0
    this.release()
  }
}

/** The incoming mail list, reusing each unchanged row's previous object; the
 * previous list itself when nothing changed. */
function mergeMail(
  previous: IssueActivityMail[],
  rows: readonly IssueActivityMail[],
): IssueActivityMail[] {
  const byId = new Map(previous.map((row) => [row.id, row]))
  let changed = rows.length !== previous.length
  const next = rows.map((row, index) => {
    const old = byId.get(row.id)
    const kept = old && sameMail(old, row) ? old : row
    if (kept !== previous[index]) changed = true
    return kept
  })
  return changed ? next : previous
}
function sameMail(a: IssueActivityMail, b: IssueActivityMail): boolean {
  return (
    a.issueId === b.issueId &&
    a.fromAuthor === b.fromAuthor &&
    a.body === b.body &&
    a.createdAt === b.createdAt &&
    a.status === b.status &&
    a.claimedBy === b.claimedBy &&
    a.wasUnread === b.wasUnread
  )
}

/** One opening of a history view (the full timeline, Recent activity, mail).
 * It holds the issue's shared history while open and asks for the window it
 * shows; `loadEarlier` pages further on request. Created per opening by the
 * view's root component; `open()` returns the close. */
export class IssueHistoryView {
  @observable accessor loading = false
  @observable accessor error: string | null = null
  private wanted: number
  private request = 0
  constructor(
    readonly activity: IssueActivityStore,
    private readonly ports: IssueActivityPorts,
    window: number,
  ) {
    this.wanted = window
  }
  /** More history exists below the loaded window. */
  @lazy get hasEarlier(): boolean {
    return this.activity.earlier
  }
  open(): () => void {
    const release = this.activity.retain(this.ports)
    void this.load()
    return () => {
      this.request++
      release()
    }
  }
  @action loadEarlier(): Promise<void> {
    this.wanted = this.activity.history.visibleEvents + ISSUE_HISTORY_PAGE
    return this.load()
  }
  @action private async load(): Promise<void> {
    if (this.wanted <= 0) return
    const request = ++this.request
    this.loading = true
    this.error = null
    try {
      await this.activity.ensure(this.wanted)
      if (request === this.request)
        runInAction(() => {
          this.loading = false
        })
    } catch (error) {
      if (request === this.request)
        runInAction(() => {
          this.loading = false
          this.error = error instanceof Error ? error.message : String(error)
        })
    }
  }
}

export function issueActivity(pool: MobxPool, id: string): IssueActivityStore {
  const owner = pool.sources.view('issue-activity', () => {
    const live = new Set<IssueActivityStore>()
    const row = companion((issue: PageIssue) => new IssueActivityStore(issue, live))
    return {
      row,
      dispose() {
        for (const activity of [...live]) activity.dispose()
        live.clear()
      },
    }
  })
  return owner.row(pool.issueObject(id) as PageIssue)
}
