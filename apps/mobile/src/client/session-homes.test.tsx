import { type SessionView, sessionValues, sessionViews } from '@podium/client-core/session-values'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import { asSessionId, asUserId, type SessionMeta } from '@podium/model'
import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture/corpus'
import {
  fixtureSessionHomes,
  stripSessionLegacy,
} from '../../../../packages/worklist-proto/harness/src/fixture/session-homes'
import { mobilePodiumRoute } from '../lib/podium-link'
import { useSession, useSessions } from './hooks'
import { renderWithMobileStore } from './test-support'

afterEach(cleanup)

const id = asSessionId('sess-homes')
const active = '2026-10-01T12:00:00.000Z'
const raw = {
  sessionId: id,
  agentKind: 'claude-code',
  cwd: '/repo',
  title: 'Agent',
  status: 'live',
  archived: false,
  lastActiveAt: active,
  refRepoId: 'repo-born',
  refSeq: 42,
  refLetter: 'B',
  machineId: 'machine-born',
  handoffTargetMachineId: 'machine-target',
  readAt: null,
  unread: true,
  snoozedUntil: null,
  displayRef: 'OLD-42-B',
  machineName: 'Old desk',
  condition: 'logged-out',
  handoffTarget: 'Old target',
  queuedMessageCount: 3,
  offer: { message: 'Choose the next step', actions: [] },
} as SessionMeta

function Probe({ seen }: { seen: { rows: SessionView[]; one?: SessionView } }) {
  seen.rows = useSessions()
  seen.one = useSession(id)
  return <div data-testid="values">{JSON.stringify(seen.one && sessionValues(seen.one))}</div>
}

describe('mobile session read seam', () => {
  it.each([
    false,
    true,
  ])('reads the same joined and optimistic view, stripped=%s', async (stripped) => {
    const row = stripped ? stripSessionLegacy(raw) : raw
    const seen: { rows: SessionView[]; one?: SessionView } = { rows: [] }
    const personal = { userId: asUserId('user:test'), sessionId: id, readAt: active }
    const { replica } = await renderWithMobileStore(<Probe seen={seen} />, {
      sessions: [row],
      sessionUserStates: [personal],
      repoProjections: [{ id: 'repo-born', prefix: 'NEW' }],
      machineProjections: [
        { id: 'machine-born', name: 'Desk', loggedOutHarnesses: [] },
        { id: 'machine-target', name: 'Target', loggedOutHarnesses: [] },
      ],
    })
    const values = () => JSON.parse(screen.getByTestId('values').textContent ?? '{}')
    expect(values()).toEqual({
      readAt: active,
      unread: false,
      displayRef: 'NEW-42-B',
      machineName: 'Desk',
      handoffTarget: 'Target',
    })
    expect(seen.one).toBe(seen.rows[0])
    expect(seen.one?.offer).toBe(raw.offer)
    expect(seen.one?.queuedMessageCount).toBe(3)
    await act(async () => {
      replica.applyChanges(
        'sessionUserStates',
        [{ ...personal, readAt: null, snoozedUntil: null }],
        [],
      )
    })
    expect(values()).toMatchObject({ readAt: null, unread: true, snoozedUntil: null })
    expect(replica.rows('sessions')[0]).toBe(row)
  })

  it('keeps an older offline row by identity until its homes arrive', async () => {
    const seen: { rows: SessionView[]; one?: SessionView } = { rows: [] }
    await renderWithMobileStore(<Probe seen={seen} />, { sessions: [raw] })
    expect(seen.one).toBe(raw)
    expect(seen.rows[0]).toBe(raw)
    expect(JSON.parse(screen.getByTestId('values').textContent ?? '{}')).toEqual(sessionValues(raw))
  })
})

it('has zero session-value, shared-card and mobile-route differences across the corpus', () => {
  const corpus = buildCorpus(1)
  const homes = fixtureSessionHomes(corpus)
  const before = sessionViews(homes.sessions, homes)
  const after = sessionViews(homes.sessions.map(stripSessionLegacy), homes)
  expect(before.length).toBe(4304)
  let routes = 0
  for (let index = 0; index < before.length; index++) {
    const withLegacy = before[index]!
    const stripped = after[index]!
    expect(sessionValues(stripped)).toEqual(sessionValues(withLegacy))
    expect(sessionCardModel(stripped, undefined, corpus.fixedNow)).toEqual(
      sessionCardModel(withLegacy, undefined, corpus.fixedNow),
    )
    const ref = sessionValues(withLegacy).displayRef
    if (!ref) continue
    routes++
    const target = { kind: 'session' as const, session: ref }
    const expected = `/session/${encodeURIComponent(withLegacy.sessionId)}`
    expect(mobilePodiumRoute(target, { issues: [], sessions: [stripped] })).toBe(expected)
    expect(mobilePodiumRoute(target, { issues: [], sessions: [withLegacy] })).toBe(expected)
  }
  expect(routes).toBeGreaterThan(0)
})
