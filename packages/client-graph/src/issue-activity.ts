import {
  IssueActivityHistory,
  type ActivityComment,
  type IssueEvent,
} from '@podium/client-core/values'
import type { IssueId } from '@podium/model/browser'
import { observable, reaction, runInAction } from 'mobx'
import type { PageIssue } from './issue-page'
import { companion } from '@podium/mobx-helpers'
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
  }): Promise<IssueEvent[]>
}

/** Request-owned view state. The same history serves full detail and Recent
 * activity; reopening advances the existing cursor instead of refetching zero.
 * The pool's source lifecycle owns principal-change disposal. */
export class IssueActivityStore {
  readonly history = new IssueActivityHistory()
  @observable.ref accessor mail: IssueActivityMail[] = []
  @observable accessor revision = 0
  private users = 0
  private stop: (() => void) | undefined
  private ports: IssueActivityPorts | undefined
  private epoch = 0
  private commentsEpoch = 0
  private draining = false
  private pending = false
  constructor(readonly issue: PageIssue) {}
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
      this.ports = ports
      const epoch = ++this.epoch
      this.stop = reaction(
        () => [this.issue.updatedAt, this.issue.repoPath] as const,
        () => this.refresh(epoch),
        { fireImmediately: true },
      )
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.users === 0) {
        this.stop?.()
        this.stop = undefined
        this.ports = undefined
        this.epoch++
        this.commentsEpoch++
      }
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
        this.history.replaceComments(Array.isArray(rows) ? rows : [])
        this.publish()
      })
      .catch(() => {})
    Promise.resolve()
      .then(() => ports.mail(this.issue.id))
      .then((rows) => {
        if (epoch !== this.epoch || request !== this.commentsEpoch) return
        runInAction(() => {
          this.mail = Array.isArray(rows) ? rows : []
        })
      })
      .catch(() => {})
    this.drain(epoch, ports)
  }
  private drain(epoch: number, ports: IssueActivityPorts) {
    if (this.draining) {
      this.pending = true
      return
    }
    this.draining = true
    this.pending = false
    const run = async () => {
      try {
        for (;;) {
          const before = this.history.since
          const rows = await ports.events({
            since: before,
            repoPath: this.issue.repoPath,
            subject: this.issue.id,
            limit: 200,
          })
          if (epoch !== this.epoch) return
          if (!Array.isArray(rows)) break
          if (this.history.appendEvents(rows)) this.publish()
          if (rows.length < 200 || this.history.since <= before) break
        }
      } catch {
        /* Preserve already loaded history on either failure shape. */
      } finally {
        this.draining = false
        if (this.pending && this.ports) this.drain(this.epoch, this.ports)
      }
    }
    void run()
  }
  dispose() {
    this.stop?.()
    this.stop = undefined
    this.ports = undefined
    this.epoch++
    this.commentsEpoch++
    this.history.reset()
    runInAction(() => {
      this.mail = []
      this.revision++
    })
  }
}

export function issueActivity(pool: MobxPool, id: string): IssueActivityStore {
  const owner = pool.sources.view('issue-activity', () => {
    const held = new Set<IssueActivityStore>()
    const row = companion((issue: PageIssue) => {
      const activity = new IssueActivityStore(issue)
      held.add(activity)
      return activity
    })
    return {
      row,
      dispose() {
        for (const activity of held) activity.dispose()
        held.clear()
      },
    }
  })
  return owner.row(pool.issueObject(id) as PageIssue)
}
