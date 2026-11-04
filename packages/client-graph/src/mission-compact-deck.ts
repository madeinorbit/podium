import { FLIGHT_DECK_FULL_ISSUES_KEY } from '@podium/client-core/ui-state'
import { companion, lazy } from '@podium/mobx-helpers'
import type { SessionWord } from '@podium/model/browser'
import { action, autorun, compareShallow } from 'mobx'
import type { MissionScreen } from './mission-screen'
import { settled } from './mission-view'
import type { SessionModel } from './models'

const STATE_ORDER: Readonly<Record<SessionWord, number>> = {
  'needs-you': 0,
  error: 1,
  working: 2,
  idle: 3,
  done: 4,
}
const millis = (value: string | undefined | null): number => Date.parse(value ?? '') || 0

/** The simple deck's view rules. Session facts and state words stay on the
 * shared records; only eligibility, ordering and presentation belong here. */
export class CompactDeck {
  private readonly session = companion((model: SessionModel) => new CompactDeckSession(model, this))

  constructor(
    readonly screen: MissionScreen,
    private readonly preferences: {
      read: (key: string) => string | null
      write: (key: string, raw: string) => void
    },
  ) {}

  row(id: string): CompactDeckSession {
    return this.session(this.screen.pool.sessionObject(id))
  }

  @lazy({ equals: compareShallow }) private get fullIssues(): readonly string[] {
    const raw = this.preferences.read(FLIGHT_DECK_FULL_ISSUES_KEY)
    try {
      const value: unknown = JSON.parse(raw ?? '[]')
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  @lazy get expanded(): boolean {
    return this.fullIssues.includes(this.screen.rootId)
  }

  /** Only the already-drawn root roster is read. Archive/native/proposal and
   * moved-work details retain Full rather than disappearing in a simple card. */
  @lazy get requiresFull(): boolean {
    const screen = this.screen
    if (!screen.ready || !screen.full.ready) return false
    return (
      screen.root.type === 'phase' ||
      screen.full.root.childIds.length > 0 ||
      screen.full.proposalIds.length > 0 ||
      screen.archivedCount > 0 ||
      Boolean(screen.note) ||
      screen.rootAbandoned ||
      screen.departures.length > 0 ||
      Boolean(screen.continuation) ||
      screen.full.root.sessionIds.length > 3 ||
      screen.full.root.sessionIds.some((id) => this.row(id).session.hasNativeSubagents)
    )
  }

  @lazy get shown(): boolean {
    return (
      settled(
        () =>
          !this.expanded &&
          this.screen.ready &&
          this.screen.full.ready &&
          this.screen.full.root.sessionIds.length > 0 &&
          !this.requiresFull,
      ) === true
    )
  }

  /** Mounted only by the desktop deck. The display preference survives a
   * reopen/reload without changing the issue or the phone's chosen view. */
  observe(): () => void {
    return autorun(() => {
      if (settled(() => !this.expanded && this.requiresFull) === true) this.rememberFull()
    })
  }

  @action private rememberFull(): void {
    if (!this.expanded)
      this.preferences.write(
        FLIGHT_DECK_FULL_ISSUES_KEY,
        JSON.stringify([...this.fullIssues, this.screen.rootId]),
      )
  }

  @lazy({ equals: compareShallow }) get sessionIds(): readonly string[] {
    return [...this.screen.full.root.sessionIds].sort((left, right) => {
      const a = this.row(left).session,
        b = this.row(right).session
      return (
        STATE_ORDER[a.word] - STATE_ORDER[b.word] ||
        Number(this.row(right).coordinator) - Number(this.row(left).coordinator) ||
        (b.activityMs ?? 0) - (a.activityMs ?? 0) ||
        millis(b.createdAt) - millis(a.createdAt) ||
        left.localeCompare(right)
      )
    })
  }

  @lazy get doneCount(): number {
    return this.screen.full.root.sessionIds.filter((id) => this.row(id).session.word === 'done')
      .length
  }
  @lazy get totalCount(): number {
    return this.screen.full.root.sessionIds.length
  }
  @lazy get startedAt(): number {
    return millis(this.screen.root.createdAt)
  }
  @lazy get finishedAt(): number {
    return this.screen.rootFinished ? millis(this.screen.root.closedAt) : 0
  }
}

/** View-specific title fallback and role over the canonical session. */
export class CompactDeckSession {
  constructor(
    readonly session: SessionModel,
    readonly deck: CompactDeck,
  ) {}

  @lazy get coordinator(): boolean {
    return this.deck.screen.full.coordinatorSessionId === this.session.id
  }
  @lazy get pendingTitle(): boolean {
    return !this.session.nameSource
  }
  @lazy get title(): string {
    const name = this.session.name?.trim()
    if (name && this.session.nameSource) return name.split(/\r?\n/, 1)[0] ?? name
    // The daemon already projects a prompt-derived title when one is known.
    // A product boot title is not a description of the work.
    const title =
      (name || this.session.title)
        .replace(/^[\p{So}\p{Sk}·•\s]+/u, '')
        .trim()
        .split(/\r?\n/, 1)[0] ?? ''
    return !title ||
      /^(?:new session|untitled|claude(?: code)?|codex|openai|gemini|grok|opencode|cursor|pi|shell)$/i.test(
        title,
      )
      ? 'New session'
      : title
  }
  @lazy get startedAt(): number {
    return millis(this.session.createdAt)
  }
  @lazy get completedAt(): number {
    return (
      millis(this.session.stoppedAt) ||
      this.deck.finishedAt ||
      this.session.doneSinceMs ||
      this.session.activityMs ||
      0
    )
  }
}
