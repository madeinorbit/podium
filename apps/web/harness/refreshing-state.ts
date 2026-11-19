import { refreshingScreenFixture } from '@podium/client-graph/refreshing-screen.test.fixture'
import { state } from './deck-store-stub'

export let fixture: Awaited<ReturnType<typeof refreshingScreenFixture>>

/** Initialize after the stubbed provider/pool module graph has finished evaluating. */
export async function initialize() {
  Object.assign(window, { refreshingStage: 'fixture' })
  fixture = await refreshingScreenFixture()
  state.issues = [...fixture.pool.tables.issue.values()]
  state.selectedIssueId = 'root'
  const surface = new URLSearchParams(location.search).get('screen') === 'board' ? 'board' : 'deck'
  fixture.mark(fixture.owned[surface])
  Object.assign(window, { refreshing: { land: () => fixture.land() } })
  Object.assign(window, { refreshingStage: 'ready' })
}
