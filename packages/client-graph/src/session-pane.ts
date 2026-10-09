import { omitGone } from './lookup'
import { worklistView } from './worklist/view-model'
import type { SessionView } from '@podium/client-core/session-values'
import { companion, lazy } from '@podium/mobx-helpers'
import { asIssueId, type IssueId, type MachineWire, machinePathAncestors, machinePathSeparator } from '@podium/model/browser'
import { headerIds } from './enumerate'
import type { IssueModel, SessionModel } from './models'
import type { MobxPool } from './pool'
import type { SessionPaneRows } from './session-pane-schema'
import { LOADING, type Loaded } from './worklist/rollup'

export function paneSession(pool: MobxPool, id: string | undefined): Loaded<SessionView> {
  return id === undefined ? undefined : (omitGone(pool.row('session', id)) as Loaded<SessionView>)
}
export function paneWindow(pool: MobxPool): Loaded<SessionPaneRows['sessionPaneWindow']> {
  return omitGone(pool.row('sessionPaneWindow', 'window'))
}
export function paneMachines(pool: MobxPool): MachineWire[] {
  return headerIds(pool, 'machine').flatMap(id => {
    const row = omitGone(pool.row('machine', id)) as MachineWire | undefined
    return row ? [row] : []
  })
}
export function paneHasSessions(pool: MobxPool): boolean {
  return pool.queries.count('session') > 0
}
export function paneSpawnConfirmed(pool: MobxPool, id: string): boolean {
  const window = paneWindow(pool)
  if (!window || window === LOADING) return false
  // Confirmation belongs to the principal's pool transaction log.
  const placeholders = pool.spawnPlaceholders()
  return placeholders !== null && !placeholders.has(id)
}

export interface PaneIssue {
  id: string
  seq: number
  archived?: boolean
  deletedAt?: string | null
  worktreePath?: string | null
  parentId?: string | null
  color?: string | null
  branch?: string | null
  gitState?: import('@podium/client-core/replica').IssueViewModel['gitState']
}
function eligibleIssue(pool: MobxPool, id: string): Loaded<PaneIssue> {
  const summary = omitGone(pool.row('issue', id, 'summary')) as Loaded<PaneIssue>
  if (summary === LOADING) return LOADING
  return summary && !summary.archived && !summary.deletedAt ? summary : undefined
}
export function paneIssueColor(pool: MobxPool, id: string | null, hex: (color: string | null | undefined) => string | undefined): Loaded<string> {
  if (!id) return undefined
  const selected = eligibleIssue(pool, id)
  if (!selected || selected === LOADING) return selected
  const seen = new Set<string>()
  let row: Loaded<PaneIssue> = selected
  while (row && row !== LOADING) {
    const own = hex(row.color)
    if (own) return own
    if (!row.parentId || seen.has(row.parentId)) return undefined
    seen.add(row.parentId)
    row = omitGone(pool.row('issue', row.parentId, 'summary')) as Loaded<PaneIssue>
  }
  return row === LOADING ? LOADING : undefined
}

const EMPTY_WINDOW: SessionPaneRows['sessionPaneWindow'] = { panelMode: {}, dockShells: {}, reposLoaded: false }

/** The session pane's rules over one shared session: what the pane stamps and
 * shows of it. Reads the session's own scalar fields, so a heartbeat (a new
 * row with only activity changed) re-runs none of them. */
export class PaneSession {
  constructor(readonly session: SessionModel, private readonly pool: MobxPool) {}

  /** The loaded display row is here (`LOADING` while its batched load runs).
   * One row read; an equal answer stops a heartbeat at this field. */
  @lazy get present(): Loaded<boolean> {
    const row = this.pool.row('session', this.session.id)
    return row === LOADING ? LOADING : row !== undefined
  }
  /** Explicit attachment wins. Checkout candidates are reached through the
   * schema's existing inverse buckets, never a scan or a separate ownership map.
   * These are the same exact slash boundaries the old pane tested. */
  @lazy get stampIssue(): Loaded<IssueModel> {
    if (this.present !== true) return undefined
    const { issueId, cwd } = this.session
    if (issueId) {
      const attached = eligibleIssue(this.pool, issueId)
      if (attached === LOADING) return LOADING
      if (attached) return this.loadedIssue(issueId)
    }
    const paths = machinePathSeparator(cwd) === '\\' ? machinePathAncestors(cwd) : [cwd]
    if (machinePathSeparator(cwd) === '/') for (let at = cwd.lastIndexOf('/'); at >= 0; at = cwd.lastIndexOf('/', at - 1)) {
      paths.push(cwd.slice(0, at))
      if (at === 0) break
    }
    for (const path of paths) {
      for (const id of this.pool.relations.many('worktree', path, 'issues')) {
        const candidate = eligibleIssue(this.pool, id)
        if (candidate === LOADING) return LOADING
        if (candidate) return this.loadedIssue(id)
      }
    }
    return undefined
  }

  private loadedIssue(id: string): Loaded<IssueModel> {
    const row = this.pool.row('issue', id)
    return row === LOADING ? LOADING : row ? this.pool.issueObject(id) : undefined
  }
}

/** The session panes' shared view: per-session companions, the selected
 * issue's tint and the device's window controls. Runtime implementations stay
 * in the lazily imported pool. Web hooks import only this API's types, so a
 * legacy startup loads no graph/MobX implementation. */
export class SessionPanes {
  readonly pane = companion((session: SessionModel) => new PaneSession(session, this.pool))
  constructor(private readonly pool: MobxPool) {}

  /** The loaded display row, for the screens that still show undeclared fields. */
  session(id: string | undefined): SessionView | undefined {
    const row = paneSession(this.pool, id)
    return row === LOADING ? undefined : row
  }
  /** The pane companion of a session whose display row is here, by ID. */
  loaded(id: string | null | undefined): PaneSession | undefined {
    if (!id) return undefined
    const pane = this.pane(this.pool.sessionObject(id))
    return pane.present === true ? pane : undefined
  }
  window(): SessionPaneRows['sessionPaneWindow'] {
    const value = paneWindow(this.pool)
    return !value || value === LOADING ? EMPTY_WINDOW : value
  }
  machines(): MachineWire[] { return paneMachines(this.pool) }
  spawnConfirmed(id: string): boolean { return paneSpawnConfirmed(this.pool, id) }
  hasSessions(): boolean { return paneHasSessions(this.pool) }

  // Ownership: the selection, never the pane's session.
  @lazy get selectedIssueId(): IssueId | null {
    const selected = worklistView(this.pool).selectedId
    return selected === null ? null : asIssueId(selected)
  }
  /** The selected issue's tint, inherited through its parents. */
  issueHex(hex: (color: string | null | undefined) => string | undefined): string | undefined {
    const color = paneIssueColor(this.pool, this.selectedIssueId, hex)
    return color === LOADING ? undefined : color
  }
}

/** Shared service view, owned by the screen rather than the core pool. */
export function sessionPaneView(pool: MobxPool): SessionPanes {
  return pool.sources.view('sessionPanes', () => new SessionPanes(pool))
}
