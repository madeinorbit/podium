import type { FlightDeckMode } from '@podium/client-core/values'
import { MissionScreen, missionRootId } from '@podium/client-graph/mission-screen'
import { settled } from '@podium/client-graph/mission-view'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'

export interface MissionPaneInput {
  selectedIssueId: string | null
  paneA: string | null
  paneB: string | null
  split: boolean
  mode: FlightDeckMode
  handoff: boolean
}

/**
 * What the mounted desktop deck reads for one selection: the root the
 * selection opens, one view model per opening, and the fields its sections
 * draw for the first `visible` task bands. The pane bundle is retired; this
 * exercises the painted fields rather than an identity-only consumer.
 */
export function missionPaneReader(pool: MobxPool, visible = 24) {
  const screens = new Map<string, MissionScreen>()
  const open = (rootId: string): MissionScreen => {
    let screen = screens.get(rootId)
    if (!screen) {
      screen = new MissionScreen(pool, rootId, { development: true })
      screen.open()
      screens.set(rootId, screen)
    }
    return screen
  }
  const read = (input: MissionPaneInput) => {
    const rootId = missionRootId(pool, input.selectedIssueId)
    let pending = rootId === LOADING
    for (const id of new Set([input.paneA, input.split ? input.paneB : null])) {
      if (id && settled(() => pool.sessionObject(id).exists) === LOADING) pending = true
    }
    if (pending || rootId === LOADING) return LOADING
    if (!rootId) return { root: undefined }
    const screen = open(rootId)
    if (!screen.ready) return LOADING
    const mode = input.mode
    const handoff = input.handoff ? screen.reader.handoff(rootId) : undefined
    if (handoff === LOADING) return LOADING
    const bands = screen.visibleRows.slice(0, visible).map((row) => ({
      key: row.key,
      title: row.title,
      ref: row.displayRef,
      status: row.status,
      presentation: settled(() => row.presentation),
      unread: row.unread(row.folded(screen.folds)),
      sessions: row.sessionIds(mode),
      rollup: row.rollup,
    }))
    return {
      root: rootId,
      header: {
        title: screen.rootTitle,
        ref: screen.rootRef,
        stage: screen.rootStage,
        status: screen.rootStatus,
        brief: screen.rootAuthoredBrief,
        note: screen.note,
        presence: screen.presence,
        progress: screen.progress,
        live: screen.liveCount,
        working: screen.workingCount,
        hosts: screen.agentHosts.map((view) => view.machine.id),
      },
      rootSessions: screen.rootRow?.sessionIds(mode) ?? [],
      bands,
      proposed: screen.proposedRows.map((row) => row.key),
      archivedCount: screen.archivedCount,
      continuation: screen.continuation,
      departures: screen.otherDepartures,
      handoff,
    }
  }
  return {
    read,
    open,
    screen: (rootId: string) => screens.get(rootId),
    dispose() {
      for (const screen of screens.values()) screen.close()
      screens.clear()
    },
  }
}
