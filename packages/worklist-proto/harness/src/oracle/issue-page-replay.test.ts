import { expect, it } from 'vitest'
import { sessionViews } from '@podium/client-core/session-values'
import { genCorpus } from '../../../shared/src/gen/changes'
import { fixtureSessionHomes, stripSessionLegacy } from '../fixture/session-homes'
import { replayIssuePages } from './issue-page-replay'

it('uses normalized session homes when replaying an existing read view', () => {
  const corpus = genCorpus()
  const homes = fixtureSessionHomes(corpus)
  const userStates = homes.userStates.map(row => ({ ...row,
    readAt: new Date(corpus.fixedNow).toISOString(),
    snoozedUntil: new Date(corpus.fixedNow + 60_000).toISOString(),
  }))
  const sessions = sessionViews(homes.sessions.map(stripSessionLegacy), { ...homes, userStates })
  const { result } = replayIssuePages({ ...corpus, sessions })
  expect(result.issues).toBeGreaterThan(0)
  expect(result).toMatchObject({ differences: 0, pending: 0, first: null })
})
