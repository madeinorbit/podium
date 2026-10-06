import { sessionViews } from '@podium/client-core/session-values'
import type { SessionUserStateWire } from '@podium/model'
import type { MachineProjection, SessionMeta } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { buildCorpus } from '../../../tests/worklist/harness/src/fixture'
import { seedAcceptanceCache } from './sidebar-acceptance-seed'

describe('browser acceptance seed', () => {
  it.each(['a', 'b'])('preserves session labels and personal state in principal %s', principal => {
    const corpus = buildCorpus(1, 4443)
    corpus.repoProjections[0] = { ...corpus.repoProjections[0]!, prefix: 'SEED' }
    const named = { ...corpus.sessions[0]!, displayRef: 'SEED-17-A',
      readAt: '2026-10-03T00:00:00.000Z', unread: false, snoozedUntil: '2026-10-04T00:00:00.000Z' }
    // Exercise an older-server row whose permanent label needs canonical birth
    // coordinates, even when the generated corpus does not contain one.
    delete named.refRepoId; delete named.refSeq; delete named.refLetter; delete named.refDraft
    corpus.sessions[0] = named
    const records = seedAcceptanceCache(corpus, principal).readEntities()
    const sessions = records.filter(row => row.entity === 'session').map(row => row.value as SessionMeta)
    const userStates = records.filter(row => row.entity === 'sessionUserState').map(row => row.value as SessionUserStateWire)
    const machines = records.filter(row => row.entity === 'machine').map(row => row.value as MachineProjection)
    const views = sessionViews(sessions, { userId: principal, userStates, machines, repos: corpus.repoProjections })
    expect(userStates).toHaveLength(corpus.sessions.length)
    expect(userStates.every(row => row.userId === principal)).toBe(true)
    expect(machines.length).toBeGreaterThan(0)
    expect(views).toHaveLength(corpus.sessions.length)
    const byId = new Map(views.map(row => [row.sessionId, row]))
    for (const expected of corpus.sessions) {
      const actual = byId.get(expected.sessionId)!
      expect({ readAt: actual.readAt, unread: actual.unread, displayRef: actual.displayRef,
        machineName: actual.machineName, condition: actual.condition, handoffTarget: actual.handoffTarget,
        archived: actual.archived, snoozedUntil: actual.snoozedUntil }, expected.sessionId).toEqual({
        readAt: expected.readAt ?? null, unread: expected.unread, displayRef: expected.displayRef,
        machineName: expected.machineName ?? '', condition: expected.condition, handoffTarget: expected.handoffTarget,
        archived: expected.archived, snoozedUntil: expected.snoozedUntil,
      })
    }
  })
})
