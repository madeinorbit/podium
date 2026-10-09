import { attachMissionTestPreferences } from '@podium/client-graph/mission-screen.test.fixture'
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
  attachMissionTestPreferences(pool)
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
  const read = (input: MissionPaneInput) => settled(() => {
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
    // The small observers all get a turn to request their shown fields even
    // when a neighbour is cold. A whole-pane diagnostic must not serialize
    // those requests by returning at the first pending field.
    let displayPending = false
    const shown = <T>(read: () => T): T => {
      const value = settled(read)
      if (value === LOADING) {
        displayPending = true
        // This partial answer is never published while a field is pending.
        return undefined as T
      }
      return value
    }
    const handoff = input.handoff ? shown(() => screen.reader.handoff(rootId)) : undefined
    const bands = screen.visibleRows.slice(0, visible).map((row) => ({
      key: row.key,
      title: shown(() => row.title),
      ref: shown(() => row.displayRef),
      status: shown(() => row.status),
      presentation: shown(() => row.presentation),
      unread: shown(() => row.unread(row.folded(screen.folds))),
      sessions: shown(() => row.sessionIds(mode)),
      rollup: shown(() => row.rollup),
    }))
    const answer = {
      root: rootId,
      header: {
        title: shown(() => screen.rootTitle),
        ref: shown(() => screen.rootRef),
        stage: shown(() => screen.rootStage),
        status: shown(() => screen.rootStatus),
        brief: shown(() => screen.rootAuthoredBrief),
        note: shown(() => screen.note),
        presence: shown(() => screen.presence),
        progress: shown(() => screen.progress),
        live: shown(() => screen.liveCount),
        working: shown(() => screen.workingCount),
        hosts: shown(() => screen.agentHosts.map((view) => view.machine.id)),
      },
      rootSessions: shown(() => screen.rootRow?.sessionIds(mode) ?? []),
      bands,
      proposed: shown(() => screen.proposedRows.map((row) => row.key)),
      archivedCount: shown(() => screen.archivedCount),
      continuation: shown(() => screen.continuation),
      departures: shown(() => screen.otherDepartures),
      handoff,
    }
    return displayPending ? LOADING : answer
  })
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
