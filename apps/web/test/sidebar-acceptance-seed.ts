import { asUserId, sessionUserStateRowId } from '@podium/model'
import type { FixtureCorpus } from '../../../tests/worklist/harness/src/fixture/corpus'
import { fixtureMarkers } from '../../../tests/worklist/harness/src/fixture/normalized-issues'
import { fixtureSessionHomes, stripSessionLegacy } from '../../../tests/worklist/harness/src/fixture/session-homes'
import { seedCacheFromCorpus } from '../../../tests/worklist/shared/src/scenarios'

/** Mirror the scenario engine's current-server seed for each fixture principal.
 * The source corpus keeps its older display cells; the runtime gets their
 * canonical homes rather than exercising an offline migration gap. */
export function seedAcceptanceCache(corpus: FixtureCorpus, principal: string) {
  const homes = fixtureSessionHomes(corpus, principal)
  const cache = seedCacheFromCorpus({
    ...corpus,
    sessions: homes.sessions.map(stripSessionLegacy),
    issueUserStates: (corpus.issueUserStates ?? fixtureMarkers(corpus.issues)).map(row => ({
      ...row, userId: asUserId(principal),
    })),
  })
  cache.install([
    ...homes.userStates.map(state => ({
      entity: 'sessionUserState' as const,
      entityId: sessionUserStateRowId(state.userId, state.sessionId), value: state,
    })),
    ...homes.machines.map(machine => ({ entity: 'machine' as const, entityId: machine.id, value: machine })),
  ])
  return cache
}
